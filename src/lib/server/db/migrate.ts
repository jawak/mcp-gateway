/**
 * Migrations (T-04).
 *
 * Single-writer rule: only the API entrypoint runs migrations, at boot, before
 * it accepts a request. The worker polls `kv.schema_version` and waits, which
 * avoids the classic `docker compose up` race where the worker migrates (or
 * fails) before the server is done.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { createDatabase, databasePath, type Db } from './index.ts';
import { kv } from './schema.ts';

export const MIGRATIONS_FOLDER = 'drizzle';

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

export function readSchemaVersion(db: Db): number {
	return Number.parseInt(getKv(db, 'schema_version') ?? '0', 10);
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
