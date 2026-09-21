/**
 * Scheduler entrypoint.
 *
 * Runs as its own process so maintenance can never delay a request: a probe that
 * hangs on a dead upstream, a retention delete that touches a million rows, and a
 * snapshot that fsyncs the whole database all belong here, not in the request path.
 *
 * Jobs are age-based and idempotent, so a worker that restarts mid-job is safe.
 */
import { UpstreamPool } from '../lib/server/upstream/pool.ts';
import { HealthMonitor, loadUpstreamRecords } from '../lib/server/upstream/health.ts';
import { effectiveSettings } from '../lib/server/settings.ts';
import { collectIdleSessions, runRetention } from '../lib/server/observability/retention.ts';
import { createBackup } from '../lib/server/backup.ts';
import { rollupHourly } from '../lib/server/observability/usage-query.ts';
import { logger } from '../lib/server/observability/logger.ts';
import { metrics } from '../lib/server/observability/metrics.ts';

const log = logger.child({ component: 'worker' });

// Read settings once per cycle rather than caching forever: the settings page can
// change them without a restart.
const pool = new UpstreamPool();
const health = new HealthMonitor(pool, { listRecords: () => loadUpstreamRecords() });

let cycle = 0;
let running = false;

async function tick(): Promise<void> {
	if (running) {
		log.warn('previous cycle still running, skipping');
		return;
	}
	running = true;
	cycle += 1;
	try {
		await health.sweepAll();

		// hourly: roll the previous hour into usage_hourly before detail is pruned
		if (cycle % 12 === 1) rollupHourly();
		// hourly: idle sessions and expired web sessions
		if (cycle % 12 === 5) log.debug(collectIdleSessions(), 'session housekeeping');
		// ~6 hourly: retention windows
		if (cycle % 72 === 9) log.info(runRetention(), 'retention applied');
		// daily: snapshot
		if (cycle % 288 === 3) log.info(createBackup(), 'snapshot written');

		metrics.refreshGauges({ pool });
	} catch (error) {
		log.error({ err: error }, 'cycle failed');
	} finally {
		running = false;
	}
}

function schedule(): ReturnType<typeof setInterval> {
	const intervalMs = Math.max(5_000, effectiveSettings().healthIntervalS * 1000);
	return setInterval(() => void tick(), intervalMs);
}

let timer = schedule();
pool.startIdleSweeper(60_000);

let stopping = false;
function stop(signal: string): void {
	if (stopping) return;
	stopping = true;
	log.info({ signal }, 'worker stopping');
	clearInterval(timer);
	void pool
		.closeAll(5_000)
		.catch((error: unknown) => log.warn({ err: error }, 'pool shutdown failed'))
		.finally(() => process.exit(0));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => stop(signal));
}

// re-read the interval periodically so a settings change takes effect without a restart
setInterval(() => {
	const wanted = Math.max(5_000, effectiveSettings().healthIntervalS * 1000);
	clearInterval(timer);
	timer = setInterval(() => void tick(), wanted);
}, 60_000).unref();

log.info(
	{ interval_ms: Math.max(5_000, effectiveSettings().healthIntervalS * 1000) },
	'worker started'
);
void tick();
