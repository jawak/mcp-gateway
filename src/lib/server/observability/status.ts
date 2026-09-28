/**
 * Process-level counters exposed on /healthz.
 * Written by the MCP session registry (T-12/T-13) and upstream health checker
 * (T-09); read-only for everything else.
 */
export const status = {
	startedAt: new Date(),
	activeSessions: 0,
	liveUpstreams: 0,
	upstreamsHealthy: 0,
	upstreamsDegraded: 0,
	upstreamsDown: 0,
	upstreamsUnconfigured: 0,
	lastHealthSweepAt: undefined as Date | undefined
};

/**
 * The shape callers can build and hand in instead of reading the global.
 *
 * `healthzPayload` reads this global by default, which made a unit test fail on CI
 * while passing on a laptop: bun runs test files in one process and the file order
 * differs per machine, so a sweep test running first left counters set and the
 * healthz payload asserting "sessions: 0" broke. Anything that depends on file
 * order is not a test — hand in a snapshot instead.
 */
export type ProcessStatus = typeof status;

export function uptimeSeconds(): number {
	return Math.floor((Date.now() - status.startedAt.getTime()) / 1000);
}
