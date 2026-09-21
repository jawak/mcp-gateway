/**
 * `bun run db:migrate` — apply migrations then bootstrap the admin.
 * The API entrypoint does the same thing at boot; this exists for CI, first
 * run, and operators.
 */
import { runMigrations } from '../src/lib/server/db/migrate.ts';
import { seedAdmin } from '../src/lib/server/db/seed.ts';
import { logger } from '../src/lib/server/observability/logger.ts';

const { db, version, file } = runMigrations();
logger.info({ file, schema_version: version }, 'migrations applied');

const seeded = await seedAdmin(db);
if (seeded.created) {
	logger.info({ email: seeded.email, reason: seeded.reason }, 'admin account created');
} else {
	logger.info({ reason: seeded.reason }, 'admin bootstrap skipped');
}
