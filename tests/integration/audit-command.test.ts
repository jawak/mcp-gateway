/**
 * The audit trail has to record what the gateway was told to execute (T-45 follow-up).
 *
 * An upstream row is arbitrary code execution on the gateway host, so "which command
 * was installed, by whom, when" is the first question in any incident review. The
 * create/update audit rows used to carry only `{transport, pin}` and a list of changed
 * field names, which cannot answer it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { desc, eq } from 'drizzle-orm';
import { createUpstream, ensureLoaded, updateUpstream } from '../../src/lib/server/registry';
import { auditLog } from '../../src/lib/server/db/schema';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-audit-cmd-'));
const actor = { actorId: 'auditor', ip: '203.0.113.9' };

function lastAudit(action: string, target: string): Record<string, unknown> | undefined {
	const row = getDb()
		.select()
		.from(auditLog)
		.where(eq(auditLog.action, action))
		.orderBy(desc(auditLog.id))
		.all()
		.find((entry) => entry.targetId === target);
	return (row?.meta ?? undefined) as Record<string, unknown> | undefined;
}

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '4'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	ensureLoaded(getDb());
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('audit records the command', () => {
	test('creating a stdio upstream records command and args', () => {
		const created = createUpstream(
			{
				slug: 'audit-cmd',
				name: 'audit-cmd',
				transport: 'stdio',
				connection: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] }
			},
			actor
		);
		const meta = lastAudit('upstream.create', 'audit-cmd');
		expect(meta?.transport).toBe('stdio');
		expect(String(meta?.command)).toContain('npx');
		expect(String(meta?.command)).toContain('@modelcontextprotocol/server-postgres');
		expect(created.slug).toBe('audit-cmd');
	});

	test('creating an http upstream records the url', () => {
		createUpstream(
			{
				slug: 'audit-url',
				name: 'audit-url',
				transport: 'http',
				connection: { url: 'https://mcp.internal/mcp' }
			},
			actor
		);
		const meta = lastAudit('upstream.create', 'audit-url');
		expect(String(meta?.url)).toContain('mcp.internal/mcp');
		expect(meta?.command).toBeUndefined();
	});

	test('changing the command is recorded; a rename alone is not', () => {
		const created = createUpstream(
			{
				slug: 'audit-edit',
				name: 'audit-edit',
				transport: 'stdio',
				connection: { command: 'uvx', args: ['mcp-server-git'] }
			},
			actor
		);

		updateUpstream(created.id, { name: 'renamed only' }, actor);
		expect(lastAudit('upstream.update', 'audit-edit')?.command).toBeUndefined();

		updateUpstream(
			created.id,
			{ connection: { command: 'uvx', args: ['evil-package-from-who-knows-where'] } },
			actor
		);
		const meta = lastAudit('upstream.update', 'audit-edit');
		expect(String(meta?.command)).toContain('evil-package-from-who-knows-where');
	});

	test('a token pasted into an argument is redacted, not copied into the audit log', () => {
		// the audit trail is exactly where an investigator would not expect to find the
		// credential they are hunting — and exactly where it must not be published
		createUpstream(
			{
				slug: 'audit-redact',
				name: 'audit-redact',
				transport: 'stdio',
				connection: {
					command: 'npx',
					args: ['-y', 'some-server', '--token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
				}
			},
			actor
		);
		const meta = lastAudit('upstream.create', 'audit-redact');
		const recorded = String(meta?.command);
		expect(recorded).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
		expect(recorded).toContain('npx');
	});
});
