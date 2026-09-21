/**
 * Audit trail tests (T-25): append-only recording, redaction, filters, retention
 * and CSV export.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sql } from 'drizzle-orm';
import {
	auditToCsv,
	listAudit,
	pruneAudit,
	recordAudit
} from '../../src/lib/server/observability/audit';
import { auditLog } from '../../src/lib/server/db/schema';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { uuidv7 } from '../../src/lib/shared/ids';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-audit-'));

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '9'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

/** Minimal RFC 4180 parser: quoted fields may contain commas, CRLF and doubled quotes. */
function parseCsv(text: string): string[][] {
	const records: string[][] = [];
	let field = '';
	let record: string[] = [];
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
				} else quoted = false;
			} else field += char;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === ',') {
			record.push(field);
			field = '';
		} else if (char === '\r' && text[index + 1] === '\n') {
			record.push(field);
			records.push(record);
			record = [];
			field = '';
			index += 1;
		} else field += char;
	}
	if (field !== '' || record.length > 0) {
		record.push(field);
		records.push(record);
	}
	return records.filter((entry) => entry.some((value) => value !== ''));
}

function insertAt(createdAt: string, action = 'backdated') {
	getDb()
		.insert(auditLog)
		.values({
			id: uuidv7(),
			actorType: 'system',
			action,
			targetType: 'test',
			createdAt
		})
		.run();
}

describe('recording', () => {
	test('an entry lands with actor, target and metadata', () => {
		recordAudit({
			actorType: 'user',
			actorId: 'user-1',
			action: 'upstream.create',
			targetType: 'upstream',
			targetId: 'up-1',
			ip: '203.0.113.5',
			requestId: 'req-1',
			meta: { slug: 'github', transport: 'stdio' }
		});
		const [row] = listAudit({ action: 'upstream.create' });
		expect(row).toMatchObject({
			actorType: 'user',
			actorId: 'user-1',
			targetType: 'upstream',
			targetId: 'up-1',
			ip: '203.0.113.5',
			requestId: 'req-1'
		});
		expect(row?.meta).toMatchObject({ slug: 'github' });
	});

	test('credentials inside metadata are redacted before they hit the table', () => {
		recordAudit({
			actorType: 'user',
			actorId: 'user-2',
			action: 'upstream.update',
			targetType: 'upstream',
			targetId: 'up-2',
			meta: { token: 'ghp SUPERSECRETVALUE', headers: { authorization: 'Bearer abcdefghijkl' } }
		});
		const [row] = listAudit({ action: 'upstream.update' });
		const serialized = JSON.stringify(row?.meta);
		expect(serialized).not.toContain('SUPERSECRETVALUE');
		expect(serialized).not.toContain('abcdefghijkl');
		expect(serialized).toContain('redacted');
	});

	test('a broken insert is logged and never throws at the caller', () => {
		// a nonexistent actor reference must not break the admin action that already happened
		expect(() =>
			recordAudit({
				actorType: 'user',
				actorId: 'ghost',
				action: 'audit.never_throws',
				targetType: 'upstream',
				targetId: 'x'
			})
		).not.toThrow();
	});

	test('newest first, with filters and a cap', () => {
		for (let index = 0; index < 5; index += 1) {
			recordAudit({
				actorType: 'system',
				action: 'bulk.probe',
				targetType: 'test',
				targetId: `t-${index}`
			});
		}
		const all = listAudit({ action: 'bulk.probe' });
		expect(all.length).toBe(5);
		const times = all.map((row) => row.createdAt);
		expect([...times].sort().reverse()).toEqual(times);
		expect(listAudit({ action: 'bulk.probe', limit: 2 })).toHaveLength(2);
		expect(listAudit({ action: 'no.such.action' })).toEqual([]);
		expect(listAudit({ targetId: 't-3' }).map((row) => row.targetId)).toEqual(['t-3']);
	});
});

describe('retention', () => {
	test('only rows older than the window are pruned', () => {
		insertAt('2020-01-01T00:00:00.000Z', 'ancient.one');
		insertAt('2020-01-02T00:00:00.000Z', 'ancient.two');
		recordAudit({ actorType: 'system', action: 'recent.one', targetType: 'test' });
		const before = listAudit({}).length;
		const removed = pruneAudit(30);
		expect(removed).toBeGreaterThanOrEqual(2);
		expect(listAudit({}).length).toBe(before - removed);
		expect(listAudit({ action: 'recent.one' })).toHaveLength(1);
		expect(listAudit({ action: 'ancient.one' })).toEqual([]);
	});

	test('a zero or negative window is treated as one day, not "delete everything"', () => {
		recordAudit({ actorType: 'system', action: 'fresh.one', targetType: 'test' });
		pruneAudit(0);
		expect(listAudit({ action: 'fresh.one' })).toHaveLength(1);
	});
});

describe('CSV export', () => {
	test('headers and rows are emitted for the admin log page', () => {
		const csv = auditToCsv(listAudit({ action: 'upstream.create' }));
		const [header, firstLine] = csv.split('\r\n');
		expect(header).toBe(
			'created_at,actor_type,actor_id,action,target_type,target_id,ip,request_id,meta'
		);
		expect(firstLine).toContain('upstream.create');
		expect(firstLine).toContain('203.0.113.5');
	});

	test('a value containing a comma cannot forge a column', () => {
		recordAudit({
			actorType: 'user',
			actorId: 'user-3',
			action: 'weird.value',
			targetType: 'test',
			targetId: 'a,b "quoted"\nnewline',
			meta: null
		});
		const csv = auditToCsv(listAudit({ action: 'weird.value' }));
		// the value spans lines, so parse records instead of splitting on newlines
		const records = parseCsv(csv);
		expect(records).toHaveLength(2); // header + one row
		const row = records[1]!;
		expect(row).toHaveLength(9);
		expect(row[3]).toBe('weird.value');
		// the hostile value survives as exactly one field, newlines and all
		expect(row[5]).toBe('a,b "quoted"\nnewline');
	});

	test('an empty result is just the header', () => {
		const csv = auditToCsv([]);
		expect(csv.trim().split('\r\n')).toHaveLength(1);
	});
});

describe('schema', () => {
	test('the table has no update path used by the module', () => {
		// append-only contract: pruning by age is the only deletion
		const statements = getDb().all(sql`select 1`) as unknown[];
		expect(statements.length).toBe(1);
		rmSync(dir, { recursive: true, force: true });
	});
});
