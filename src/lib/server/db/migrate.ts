/**
 * Migrations (T-04) and schema-readiness checks.
 *
 * Single-writer rule: the API entrypoint runs migrations at boot, before it
 * accepts a request; `vite dev` does the same because it has no separate
 * entrypoint. Nothing in the request path ever runs DDL — N replicas racing
 * `ALTER TABLE` is an outage pattern. The worker polls `kv.schema_version` and
 * waits (see `waitForMigrations`, called from `entrypoints/worker.ts`), which
 * avoids the `docker compose up` race where the worker sweeps a schema that does
 * not exist yet.
 *
 * A database that has not been migrated is an *expected* state, not an error:
 * every probe here returns a value instead of throwing, so callers can render a
 * helpful "run `bun run db:migrate`" response rather than a stack trace.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, databasePath, getDb, type Db } from './index.ts';
import { kv } from './schema.ts';

export const MIGRATIONS_FOLDER = 'drizzle';

/** Tables that must exist for the gateway to serve anything. */
const REQUIRED_TABLES = ['kv', 'upstreams', 'profiles', 'api_keys'] as const;

export const MIGRATE_HINT = 'run `bun run db:migrate`';

/**
 * True when the schema exists. Never throws: a fresh or empty database file is a
 * normal first-run state, and this is called on request paths.
 */
export function schemaIsPresent(db: Db = getDb()): boolean {
	try {
		const rows = db.all(
			sql`select name from sqlite_master where type = 'table' and name in ('kv', 'upstreams', 'profiles', 'api_keys')`
		) as Array<{ name: string }>;
		return rows.length === REQUIRED_TABLES.length;
	} catch {
		return false;
	}
}

export type MigrationsState =
	| { ok: true; version: number; expected: number }
	| {
			ok: false;
			reason: 'no-database' | 'no-schema' | 'outdated';
			version: number;
			expected: number;
			hint: string;
	  };

/**
 * Is this database usable? Distinguishes the cases so the message an operator
 * sees matches what is actually wrong.
 *
 * Deliberately does not require the whole configuration to be valid: this runs on
 * the request path to decide between serving and answering 503, and a readiness
 * probe must not itself throw because of an unrelated bad variable.
 */
export function assertMigrated(
	db: Db = getDb(),
	root: string = process.cwd(),
	file?: string
): MigrationsState {
	const expected = expectedSchemaVersion(root);
	if (!schemaIsPresent(db)) {
		return {
			ok: false,
			reason: databaseFileExists(file) ? 'no-schema' : 'no-database',
			version: 0,
			expected,
			hint: MIGRATE_HINT
		};
	}
	const version = readSchemaVersion(db);
	if (version < expected) {
		return { ok: false, reason: 'outdated', version, expected, hint: MIGRATE_HINT };
	}
	return { ok: true, version, expected };
}

function databaseFileExists(file?: string): boolean {
	if (file !== undefined) return existsSync(file);
	try {
		return existsSync(databasePath());
	} catch {
		// unreadable config says nothing about the file; do not claim it is missing
		return true;
	}
}

export function expectedSchemaVersion(root: string = process.cwd()): number {
	const journal = JSON.parse(
		readFileSync(path.join(root, MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')
	) as { entries: unknown[] };
	return journal.entries.length;
}

export type MigrateResult = { db: Db; version: number; file: string };

export function runMigrations(options: { dataDir?: string; root?: string } = {}): MigrateResult {
	const root = options.root ?? process.cwd();
	const folder = path.join(root, MIGRATIONS_FOLDER);
	if (!existsSync(folder)) {
		throw new Error(`no migrations folder at ${folder} — run \`bun run db:generate\``);
	}
	const file = options.dataDir ? databasePath(options.dataDir) : databasePath();
	const { db } = createDatabase(file);
	migrate(db as Parameters<typeof migrate>[0], { migrationsFolder: folder });
	const version = expectedSchemaVersion(root);
	setKv(db, 'schema_version', String(version));
	return { db, version, file };
}

export function getKv(db: Db, key: string): string | undefined {
	const row = db.select().from(kv).where(eq(kv.key, key)).get();
	return row?.value;
}

export function setKv(db: Db, key: string, value: string): void {
	db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value } }).run();
}

/**
 * `0` when the table does not exist yet. The pollers and cache-version readers
 * treat "no database yet" as "nothing applied" and wait, rather than crashing on
 * a state that is normal during startup and on first run.
 */
export function readSchemaVersion(db: Db): number {
	try {
		return Number.parseInt(getKv(db, 'schema_version') ?? '0', 10);
	} catch {
		return 0;
	}
}

/**
 * Block until the database is at least at the journal's version (worker startup).
 * Throws after `timeoutMs` so a broken deploy surfaces instead of hanging.
 */
export async function waitForMigrations(
	options: { dataDir?: string; root?: string; timeoutMs?: number; intervalMs?: number } = {}
): Promise<number> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const intervalMs = options.intervalMs ?? 250;
	const expected = expectedSchemaVersion(options.root);
	const deadline = Date.now() + timeoutMs;
	const file = options.dataDir ? databasePath(options.dataDir) : databasePath();
	const { db } = createDatabase(file);
	while (Date.now() < deadline) {
		const version = readSchemaVersion(db);
		if (version >= expected) return version;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`database is not migrated after ${timeoutMs}ms (expected ${expected}) — start the gateway first`
	);
}
