/**
 * Prometheus exposition (T-26).
 *
 * Only the metrics the PRD's acceptance criteria actually need, with the labels
 * an operator reaches for when something is wrong: which upstream, which tool,
 * which key. Cardinality is deliberately capped — `tool` comes from the catalog
 * (bounded by what upstreams expose) and the key label is the key *name*, which
 * the operator controls, rather than a high-cardinality id.
 *
 * The registry is per-process, so the API process reports request/session/gauge
 * numbers and the worker reports health gauges; scraping both gives the full
 * picture, and each process only publishes what it actually knows.
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { status } from './status.ts';
import type { SessionRegistry } from '../mcp/session.ts';
import type { ToolCatalog } from '../mcp/catalog.ts';
import type { UpstreamPool } from '../upstream/pool.ts';

export type GatewayMetrics = {
	registry: Registry;
	recordCall(input: { upstream: string; tool: string; status: string; durationMs: number }): void;
	recordRateLimited(keyName: string): void;
	recordAuthFailure(reason: string): void;
	/** Pull the current in-memory state into gauges (call before scraping or on a timer). */
	refreshGauges(sources: {
		sessions?: SessionRegistry;
		catalog?: ToolCatalog;
		pool?: UpstreamPool;
	}): void;
	expose(): Promise<string>;
};

export function createMetrics(
	options: { includeDefaults?: boolean; appName?: string } = {}
): GatewayMetrics {
	const registry = new Registry();
	if (options.includeDefaults !== false) collectDefaultMetrics({ register: registry });
	const appName = options.appName ?? 'mcp-gateway';

	const calls = new Counter({
		name: 'mcp_tool_calls_total',
		help: 'Tool calls by upstream, tool and outcome',
		labelNames: ['upstream', 'tool', 'status'],
		registers: [registry]
	});

	const duration = new Histogram({
		name: 'mcp_tool_call_duration_seconds',
		help: 'Upstream tool call duration',
		labelNames: ['upstream', 'tool'],
		// tool calls are slow by nature: 5ms to 2 minutes
		buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
		registers: [registry]
	});

	const rateLimited = new Counter({
		name: 'mcp_rate_limited_total',
		help: 'Requests refused by the rate limiter or daily quota',
		labelNames: ['key'],
		registers: [registry]
	});

	const authFailures = new Counter({
		name: 'mcp_auth_failures_total',
		help: 'Failed authentications by reason',
		labelNames: ['reason'],
		registers: [registry]
	});

	const sessions = new Gauge({
		name: 'mcp_active_sessions',
		help: 'Live MCP sessions in this process',
		registers: [registry]
	});

	const upstreamHealthy = new Gauge({
		name: 'mcp_upstream_healthy',
		help: 'Upstreams by health state (1/0 per state)',
		labelNames: ['state'],
		registers: [registry]
	});

	const poolLive = new Gauge({
		name: 'mcp_pooled_upstreams',
		help: 'Live upstream connections in the pool',
		registers: [registry]
	});

	const catalogUpstreams = new Gauge({
		name: 'mcp_catalog_upstreams',
		help: 'Upstreams with a cached tool list, and how stale the cache is',
		labelNames: ['slug', 'state'],
		registers: [registry]
	});

	const build = new Gauge({
		name: 'mcp_build_info',
		help: 'Build information',
		labelNames: ['app', 'version'],
		registers: [registry]
	});
	build.labels(appName, process.env.npm_package_version ?? '0.0.0').set(1);

	return {
		registry,
		recordCall({ upstream, tool, status: outcome, durationMs }) {
			calls.labels(upstream, tool, outcome).inc();
			duration.labels(upstream, tool).observe(durationMs / 1000);
		},
		recordRateLimited(keyName) {
			rateLimited.labels(keyName).inc();
		},
		recordAuthFailure(reason) {
			authFailures.labels(reason).inc();
		},
		refreshGauges(sources) {
			sessions.set(sources.sessions?.count ?? status.activeSessions);
			upstreamHealthy.labels('healthy').set(status.upstreamsHealthy);
			upstreamHealthy.labels('degraded').set(status.upstreamsDegraded);
			upstreamHealthy.labels('down').set(status.upstreamsDown);
			upstreamHealthy.labels('unconfigured').set(status.upstreamsUnconfigured);
			const pool = sources.pool?.stats();
			if (pool) poolLive.set(pool.live);
			// the cache is small (one row per upstream); safe to publish per slug
			if (sources.catalog) {
				for (const entry of sources.catalog.stats().cached) {
					catalogUpstreams
						.labels(entry.slug, entry.error ? 'error' : 'ok')
						.set(Math.round(entry.ageMs));
				}
			}
		},
		async expose() {
			return registry.metrics();
		}
	};
}

/** Process-wide metrics for the API process. */
export const metrics = createMetrics();
