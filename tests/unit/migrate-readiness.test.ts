import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	assertMigrated,
	expectedSchemaVersion,
	MIGRATE_HINT,
	schemaIsPresent
} from '../../src/lib/server/db/migrate';
import { createDatabase } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';

/**
 * Readiness checks on a database that has never been migrated (T-44 plan, phase 1).
 *
 * Every other test file migrates in `beforeAll`, which is precisely why the
 * broken first-run experience shipped: nothing in the suite ever looked at a
 * database with no tables.
 */
function freshDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), 'mcpgw-ready-'));
}

describe('schemaIsPresent', () => {
	test('is false for a brand new database file with no tables', () => {
		const dir = freshDir();
		try {
			// opening the database creates the file — that alone is not "migrated"
			const { db } = createDatabase(path.join(dir, 'mcpgw.db'));
			expect(schemaIsPresent(db)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('is true once migrations have been applied', () => {
		const dir = freshDir();
		try {
			const { db } = runMigrations({ dataDir: dir });
			expect(schemaIsPresent(db)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('never throws, whatever it is handed', () => {
		// a caller on the request path must be able to ask this cheaply and safely
		const broken = createDatabase(path.join(freshDir(), 'x.db'));
		broken.sqlite.close();
		expect(() => schemaIsPresent(broken.db)).not.toThrow();
		expect(schemaIsPresent(broken.db)).toBe(false);
	});
});

describe('assertMigrated', () => {
	test('reports no-schema with an actionable hint on an empty database', () => {
		const dir = freshDir();
		process.env.MCPGW_DATA_DIR = dir;
		try {
			const { db } = createDatabase(path.join(dir, 'mcpgw.db'));
			const state = assertMigrated(db);
			expect(state.ok).toBe(false);
			if (state.ok) return;
			expect(['no-schema', 'no-database']).toContain(state.reason);
			expect(state.hint).toContain(MIGRATE_HINT);
			expect(state.hint).toContain('db:migrate');
			expect(state.version).toBe(0);
			expect(state.expected).toBe(expectedSchemaVersion());
		} finally {
			delete process.env.MCPGW_DATA_DIR;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('reports ok with matching versions after migrating', () => {
		const dir = freshDir();
		process.env.MCPGW_DATA_DIR = dir;
		try {
			const { db, version } = runMigrations({ dataDir: dir });
			const state = assertMigrated(db);
			expect(state).toMatchObject({ ok: true, version, expected: expectedSchemaVersion() });
		} finally {
			delete process.env.MCPGW_DATA_DIR;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('readSchemaVersion on an unmigrated database', () => {
	test('returns 0 instead of throwing (the poller must wait, not crash)', async () => {
		const dir = freshDir();
		try {
			const { db } = createDatabase(path.join(dir, 'mcpgw.db'));
			const { readSchemaVersion } = await import('../../src/lib/server/db/migrate');
			expect(readSchemaVersion(db)).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
