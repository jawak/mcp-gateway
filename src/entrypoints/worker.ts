/**
 * Scheduler entrypoint (T-02 skeleton, logic lands in T-09/T-13/T-46).
 *
 * Runs as a second container/process so a slow upstream probe can never block
 * the request path. Each job is a no-op until its owning task wires it up:
 *   - health sweep      → T-09
 *   - session GC        → T-13
 *   - usage aggregation → T-26
 *   - retention + backup→ T-46
 */
import { events } from '../lib/server/registry/events.ts';
import { runtime } from '../lib/server/runtime.ts';
import { logger } from '../lib/server/observability/logger.ts';

const log = logger.child({ component: 'worker' });
const healthIntervalMs = Number.parseInt(process.env.MCPGW_HEALTH_INTERVAL_S ?? '30', 10) * 1000;

let ticks = 0;
const timer = setInterval(() => {
	ticks += 1;
	log.debug({ ticks, health_interval_ms: healthIntervalMs }, 'worker tick');
	// T-09: await health.sweepAll();  T-13: await sessions.collectGarbage();
}, healthIntervalMs);

let stopping = false;
function stop(signal: string): void {
	if (stopping) return;
	stopping = true;
	clearInterval(timer);
	log.info({ signal, ticks }, 'worker stopping');
	events.emit('shutdown', { reason: signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM' });
	setTimeout(() => process.exit(0), 100).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => stop(signal));
}

log.info(
	{ health_interval_ms: healthIntervalMs, data_dir: runtime.dataDir, version: runtime.version },
	'worker started'
);
