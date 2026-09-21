/**
 * Snapshots (T-46).
 *
 * SQLite's online backup statement (`VACUUM INTO`) is used rather than copying the
 * file: WAL mode means a raw copy can miss committed transactions still in the
 * write-ahead log, which is exactly the failure you only discover while restoring.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.ts';
import { getDb, getSqlite } from './db/index.ts';
import { setKv } from './db/migrate.ts';
import { effectiveSettings } from './settings.ts';
import { logger } from './observability/logger.ts';

export type Snapshot = { name: string; path: string; bytes: number; createdAt: string };

export function backupDir(dataDir: string = getConfig().dataDir): string {
	return path.join(dataDir, 'backups');
}

export function createBackup(dataDir: string = getConfig().dataDir): Snapshot {
	const dir = backupDir(dataDir);
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const target = path.join(dir, `mcpgw-${stamp}.db`);
	getSqlite().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
	setKv(getDb(), 'last_backup_at', new Date().toISOString());
	const info = {
		name: path.basename(target),
		path: target,
		bytes: statSync(target).size,
		createdAt: new Date().toISOString()
	};
	logger.info({ target, bytes: info.bytes }, 'snapshot written');
	pruneBackups(dataDir);
	return info;
}

export function listBackups(dataDir: string = getConfig().dataDir): Snapshot[] {
	const dir = backupDir(dataDir);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.startsWith('mcpgw-') && name.endsWith('.db'))
		.map((name) => {
			const full = path.join(dir, name);
			return {
				name,
				path: full,
				bytes: statSync(full).size,
				createdAt: statSync(full).mtime.toISOString()
			};
		})
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function pruneBackups(dataDir: string = getConfig().dataDir): number {
	const keep = Math.max(1, effectiveSettings().retentionBackups);
	const snapshots = listBackups(dataDir);
	let removed = 0;
	for (const snapshot of snapshots.slice(keep)) {
		try {
			rmSync(snapshot.path);
			removed += 1;
		} catch (error) {
			logger.warn({ err: error, path: snapshot.path }, 'could not remove old snapshot');
		}
	}
	return removed;
}

/**
 * Where a snapshot must be restored from.
 *
 * There is deliberately no in-process restore: swapping the live file under an open
 * connection is how you get a corrupt database. The restore path is a documented
 * stop → copy → start procedure, and the UI hands the operator the exact commands.
 */
export function restoreInstructions(
	name: string,
	dataDir: string = getConfig().dataDir
): { snapshot: string; target: string; steps: string[] } {
	const dir = backupDir(dataDir);
	const snapshot = path.join(dir, name);
	if (!existsSync(snapshot)) throw new Error(`no snapshot named ${name}`);
	return {
		snapshot,
		target: path.join(dataDir, 'mcpgw.db'),
		steps: [
			'docker compose stop gateway worker',
			`cp ${path.join(dir, name)} /data/mcpgw.db`,
			'rm -f /data/mcpgw.db-wal /data/mcpgw.db-shm',
			'docker compose up -d'
		]
	};
}
