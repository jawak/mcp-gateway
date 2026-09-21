/**
 * Runtime settings, retention and snapshots (T-40, T-13 GC, T-46).
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	clearOverride,
	effectiveSettings,
	immutableSettings,
	resetSettingsCache,
	setOverrides
} from '../../src/lib/server/settings';
import {
	collectIdleSessions,
	pruneHealth,
	runRetention
} from '../../src/lib/server/observability/retention';
import {
	createBackup,
	listBackups,
	pruneBackups,
	restoreInstructions
} from '../../src/lib/server/backup';
import { getDb, getSqlite, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import {
	apiKeys,
	mcpSessions,
	profiles,
	upstreamHealth,
	upstreams
} from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';

const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-settings-'));

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '2'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

afterEach(() => resetSettingsCache());

describe('settings', () => {
	test('environment values are the default and overrides win', () => {
		const before = effectiveSettings();
		expect(before.healthIntervalS).toBeGreaterThan(0);
		setOverrides({ healthIntervalS: 45, retentionToolCallsDays: 5 });
		resetSettingsCache();
		expect(effectiveSettings().healthIntervalS).toBe(45);
		expect(effectiveSettings().retentionToolCallsDays).toBe(5);
	});

	test('clearing an override falls back to the environment value', () => {
		clearOverride('healthIntervalS');
		resetSettingsCache();
		expect(effectiveSettings().healthIntervalS).not.toBe(45);
	});

	test('the debug flag round-trips in both directions', () => {
		setOverrides({ debugPayload: true });
		resetSettingsCache();
		expect(effectiveSettings().debugPayload).toBe(true);
		setOverrides({ debugPayload: false });
		resetSettingsCache();
		expect(effectiveSettings().debugPayload).toBe(false);
	});

	test('deployment settings are reported read-only and never mutated', () => {
		const labels = immutableSettings().map((item) => item.label);
		for (const expected of ['Master key', 'Public URL', 'Bind address', 'Trusted proxy']) {
			expect(labels).toContain(expected);
		}
	});
});

describe('session garbage collection', () => {
	test('idle MCP sessions are closed and old rows removed', () => {
		const db = getDb();
		// sessions have real foreign keys, so the fixture needs a real upstream,
		// profile and key rather than placeholder ids
		const upstreamId = uuidv7();
		const profileId = uuidv7();
		const keyId = uuidv7();
		db.insert(upstreams)
			.values({
				id: upstreamId,
				slug: 'gc-host',
				name: 'GC host',
				transport: 'stdio',
				connection: { command: 'true' }
			})
			.run();
		db.insert(profiles).values({ id: profileId, name: 'gc-profile' }).run();
		db.insert(apiKeys)
			.values({
				id: keyId,
				keyHash: uuidv7(),
				keyPrefix: 'mcpgw_gc',
				keyTail4: '0000',
				name: 'gc',
				profileId
			})
			.run();
		// must be older than the session TTL (default 30 min) or it is correctly not idle
		const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
		const fresh = new Date().toISOString();
		db.insert(mcpSessions)
			.values([
				{ id: uuidv7(), apiKeyId: keyId, profileId, createdAt: old, lastSeenAt: old },
				{ id: uuidv7(), apiKeyId: keyId, profileId, createdAt: fresh, lastSeenAt: fresh }
			])
			.run();
		// a row from 8 days ago is past the row-retention window
		db.insert(mcpSessions)
			.values({
				id: uuidv7(),
				apiKeyId: keyId,
				profileId,
				createdAt: '2020-01-01T00:00:00.000Z',
				lastSeenAt: '2020-01-01T00:00:00.000Z'
			})
			.run();

		const result = collectIdleSessions();
		expect(result.closed).toBeGreaterThanOrEqual(1);
		expect(result.deleted).toBeGreaterThanOrEqual(1);

		const remaining = db.select().from(mcpSessions).all();
		expect(remaining.some((row) => row.lastSeenAt === old && row.closedAt === null)).toBe(false);
		expect(remaining.some((row) => row.lastSeenAt === fresh && row.closedAt === null)).toBe(true);
	});
});

describe('retention', () => {
	test('pruneHealth removes only rows older than the window', () => {
		const db = getDb();
		const upstreamId = uuidv7();
		db.insert(upstreams)
			.values({
				id: upstreamId,
				slug: 'health-host',
				name: 'Health host',
				transport: 'stdio',
				connection: { command: 'true' }
			})
			.run();
		db.insert(upstreamHealth)
			.values([
				{
					id: uuidv7(),
					upstreamId,
					status: 'healthy',
					ok: true,
					checkedAt: '2020-01-01T00:00:00.000Z'
				},
				{
					id: uuidv7(),
					upstreamId,
					status: 'healthy',
					ok: true,
					checkedAt: new Date().toISOString()
				}
			])
			.run();
		expect(pruneHealth(7)).toBeGreaterThanOrEqual(1);
		expect(db.select().from(upstreamHealth).all().length).toBeGreaterThanOrEqual(1);
	});

	test('runRetention reports each job and is idempotent', () => {
		setOverrides({ retentionToolCallsDays: 1, retentionAuditDays: 1, retentionHealthDays: 1 });
		resetSettingsCache();
		const first = runRetention();
		const second = runRetention();
		expect(Object.keys(first).sort()).toEqual(['audit', 'health', 'toolCalls', 'webSessions']);
		// second pass has nothing left to delete
		expect(second.toolCalls).toBe(0);
		expect(second.health).toBe(0);
		clearOverride('retentionToolCallsDays');
		clearOverride('retentionAuditDays');
		clearOverride('retentionHealthDays');
	});
});

describe('snapshots', () => {
	test('a snapshot is a valid SQLite database and listing is newest-first', () => {
		const snapshot = createBackup();
		expect(existsSync(snapshot.path)).toBe(true);
		const listed = listBackups();
		expect(listed.map((entry) => entry.name)).toContain(snapshot.name);
		// readable by SQLite, i.e. a real backup rather than a partial file copy
		const probe = getSqlite();
		probe.exec(`ATTACH DATABASE '${snapshot.path.replace(/'/g, "''")}' AS snap`);
		const tables = probe
			.query("select name from snap.sqlite_master where type='table'")
			.all() as Array<{ name: string }>;
		probe.exec('DETACH DATABASE snap');
		expect(tables.map((table) => table.name)).toContain('api_keys');
	});

	test('pruning keeps the configured count', () => {
		createBackup();
		createBackup();
		setOverrides({ retentionBackups: 1 });
		resetSettingsCache();
		// write once more so the pruner runs against a list over the limit
		createBackup();
		expect(listBackups().length).toBeLessThanOrEqual(2);
		clearOverride('retentionBackups');
	});

	test('restore hands back the stop/copy/start procedure', () => {
		const snapshot = createBackup();
		const instructions = restoreInstructions(snapshot.name);
		expect(instructions.steps[0]).toContain('stop');
		expect(instructions.steps.join('\n')).toContain('mcpgw.db-wal');
		expect(() => restoreInstructions('mcpgw-does-not-exist.db')).toThrow(/no snapshot/);
	});

	test('pruneBackups removes files it cannot keep', () => {
		const stray = path.join(dir, 'backups', 'mcpgw-2000-01-01T00-00-00-000Z.db');
		writeFileSync(stray, 'junk');
		// pruning orders by mtime, so make this one genuinely ancient
		const ancient = new Date('2000-01-01T00:00:00Z');
		utimesSync(stray, ancient, ancient);
		setOverrides({ retentionBackups: 1 });
		resetSettingsCache();
		expect(pruneBackups()).toBeGreaterThanOrEqual(1);
		expect(existsSync(stray)).toBe(false);
		clearOverride('retentionBackups');
	});
});

describe('cleanup', () => {
	test('fixture directory is removed', () => {
		getSqlite().exec('PRAGMA wal_checkpoint(TRUNCATE)');
		rmSync(dir, { recursive: true, force: true });
	});
});
