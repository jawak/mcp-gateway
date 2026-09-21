/**
 * Scheduler entrypoint.
 *
 * Runs as a second process (see deploy/docker-compose.yml) so a slow upstream
 * probe can never delay a request. Jobs:
 *   - health sweep on MCPGW_HEALTH_INTERVAL_S  (T-09)
 *   - idle upstream sweeper                    (T-08)
 *   - session GC, usage rollup, retention, backup → T-13 / T-26 / T-46
 */
import { getConfig } from '../lib/server/config.ts';
import { waitForMigrations } from '../lib/server/db/migrate.ts';
import { UpstreamPool } from '../lib/server/upstream/pool.ts';
import { HealthMonitor, loadUpstreamRecords } from '../lib/server/upstream/health.ts';
import { events } from '../lib/server/registry/events.ts';
import { logger } from '../lib/server/observability/logger.ts';

const log = logger.child({ component: 'worker' });
const config = getConfig();

// The API process owns migrations; start only once the schema is current.
const schemaVersion = await waitForMigrations({ timeoutMs: 60_000 });
log.info({ schema_version: schemaVersion, interval_ms: config.healthIntervalMs }, 'worker started');

const pool = new UpstreamPool();
const health = new HealthMonitor(pool, { listRecords: () => loadUpstreamRecords() });
pool.startIdleSweeper(60_000);

let sweeping = false;
async function tick(): Promise<void> {
	if (sweeping) {
		log.warn('previous health sweep still running, skipping this tick');
		return;
	}
	sweeping = true;
	const started = Date.now();
	try {
		const result = await health.sweepAll();
		if (result.changed.length > 0 || result.checked > 0) {
			log.info(
				{
					checked: result.checked,
					skipped: result.skipped,
					changed: result.changed,
					ms: Date.now() - started
				},
				'health sweep finished'
			);
		}
	} catch (error) {
		log.error({ err: error }, 'health sweep failed');
	} finally {
		sweeping = false;
	}
}

const timer = setInterval(() => void tick(), config.healthIntervalMs);

// First sweep immediately so the dashboard has data without waiting 30s.
await tick();

let stopping = false;
function stop(signal: string): void {
	if (stopping) return;
	stopping = true;
	clearInterval(timer);
	log.info({ signal }, 'worker stopping');
	events.emit('shutdown', { reason: signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM' });
	void pool
		.closeAll(5_000)
		.catch((error: unknown) => log.error({ err: error }, 'pool shutdown failed'))
		.finally(() => process.exit(0));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => stop(signal));
}
