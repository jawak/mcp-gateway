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

export function uptimeSeconds(): number {
	return Math.floor((Date.now() - status.startedAt.getTime()) / 1000);
}
