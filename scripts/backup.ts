/**
 * SQLite snapshot backup (T-04 script; scheduled from T-46).
 *
 * Uses SQLite's online backup API (`VACUUM INTO`), which is safe against a
 * running WAL writer and produces a single compact file — unlike copying
 * `mcpgw.db` + `-wal` by hand. Old snapshots beyond MCPGW_RETENTION_BACKUPS are
 * pruned.
 *
 * Usage: bun run scripts/backup.ts [--data-dir ./data] [--keep 14]
 */
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/lib/server/config.ts';
import { getSqlite } from '../src/lib/server/db/index.ts';
import { logger } from '../src/lib/server/observability/logger.ts';
import { setKv } from '../src/lib/server/db/migrate.ts';
import { getDb } from '../src/lib/server/db/index.ts';

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

const config = getConfig();
const dataDir = path.resolve(arg('data-dir') ?? config.dataDir);
const keep = Number.parseInt(arg('keep') ?? String(config.retention.backups), 10);
const backupDir = path.join(dataDir, 'backups');

mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(backupDir, `mcpgw-${stamp}.db`);

const sqlite = getSqlite();
sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const files = readdirSync(backupDir)
	.filter((name) => name.startsWith('mcpgw-') && name.endsWith('.db'))
	.sort();
const stale = files.slice(0, Math.max(0, files.length - keep));
for (const name of stale) unlinkSync(path.join(backupDir, name));

setKv(getDb(), 'last_backup_at', new Date().toISOString());
logger.info(
	{ target, total: files.length, pruned: stale.length, keep },
	'database snapshot written'
);
