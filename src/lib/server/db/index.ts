/**
 * SQLite connection (T-04).
 *
 * `bun:sqlite` is synchronous and compiled into Bun, so no native build step is
 * needed in the Docker image. WAL + busy_timeout lets the API process and the
 * worker share one file; foreign keys are per-connection and must be enabled
 * explicitly (cascades in `schema.ts` rely on it).
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { getConfig } from '../config.ts';
import { schema, type DbSchema } from './schema.ts';

export const DB_FILENAME = 'mcpgw.db';

export type Db = BunSQLiteDatabase<DbSchema>;

export function databasePath(dataDir: string = getConfig().dataDir): string {
	return path.join(dataDir, DB_FILENAME);
}

export function createDatabase(file: string): { db: Db; sqlite: Database } {
	mkdirSync(path.dirname(file), { recursive: true });
	const sqlite = new Database(file, { create: true });
	sqlite.exec('PRAGMA journal_mode = WAL');
	sqlite.exec('PRAGMA busy_timeout = 5000');
	sqlite.exec('PRAGMA foreign_keys = ON');
	// WAL + NORMAL survives a crash without fsync on every write
	sqlite.exec('PRAGMA synchronous = NORMAL');
	return { db: drizzle(sqlite, { schema }) as Db, sqlite };
}

let singleton: { db: Db; sqlite: Database } | undefined;

/** Process-wide connection, opened on first use against MCPGW_DATA_DIR. */
export function getDb(): Db {
	singleton ??= createDatabase(databasePath());
	return singleton.db;
}

export function getSqlite(): Database {
	singleton ??= createDatabase(databasePath());
	return singleton.sqlite;
}

export function closeDb(): void {
	singleton?.sqlite.close();
	singleton = undefined;
}

/** Test hook: point the singleton at an explicit file. */
export function useDatabaseForTests(file: string): void {
	singleton?.sqlite.close();
	singleton = createDatabase(file);
}
