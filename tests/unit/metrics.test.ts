import { describe, expect, test } from 'bun:test';
import { createMetrics } from '../../src/lib/server/observability/metrics';
import { status } from '../../src/lib/server/observability/status';

async function text(metrics: ReturnType<typeof createMetrics>): Promise<string> {
	return metrics.expose();
}

describe('counters', () => {
	test('a recorded call appears in both the counter and the histogram', async () => {
		const metrics = createMetrics({ includeDefaults: false });
		metrics.recordCall({ upstream: 'github', tool: 'create_pr', status: 'ok', durationMs: 42 });
		metrics.recordCall({ upstream: 'github', tool: 'create_pr', status: 'ok', durationMs: 130 });
		metrics.recordCall({ upstream: 'sentry', tool: 'list_events', status: 'error', durationMs: 5 });
		const body = await text(metrics);
		expect(body).toContain(
			'mcp_tool_calls_total{upstream="github",tool="create_pr",status="ok"} 2'
		);
		expect(body).toContain(
			'mcp_tool_calls_total{upstream="sentry",tool="list_events",status="error"} 1'
		);
		// histogram in seconds, bucketed around the observed values
		expect(body).toContain(
			'mcp_tool_call_duration_seconds_bucket{le="0.05",upstream="github",tool="create_pr"} 1'
		);
		expect(body).toContain(
			'mcp_tool_call_duration_seconds_count{upstream="github",tool="create_pr"} 2'
		);
	});

	test('rate limiting and auth failures are counted separately', async () => {
		const metrics = createMetrics({ includeDefaults: false });
		metrics.recordRateLimited('laptop');
		metrics.recordRateLimited('laptop');
		metrics.recordRateLimited('ci');
		metrics.recordAuthFailure('unknown');
		metrics.recordAuthFailure('revoked');
		metrics.recordAuthFailure('revoked');
		const body = await text(metrics);
		expect(body).toContain('mcp_rate_limited_total{key="laptop"} 2');
		expect(body).toContain('mcp_rate_limited_total{key="ci"} 1');
		expect(body).toContain('mcp_auth_failures_total{reason="revoked"} 2');
	});
});

describe('gauges', () => {
	test('health counters are pulled from the shared status object at scrape time', async () => {
		const metrics = createMetrics({ includeDefaults: false });
		status.upstreamsHealthy = 7;
		status.upstreamsDegraded = 2;
		status.upstreamsDown = 1;
		status.upstreamsUnconfigured = 3;
		status.activeSessions = 11;
		metrics.refreshGauges({});
		const body = await text(metrics);
		expect(body).toContain('mcp_upstream_healthy{state="healthy"} 7');
		expect(body).toContain('mcp_upstream_healthy{state="degraded"} 2');
		expect(body).toContain('mcp_upstream_healthy{state="down"} 1');
		expect(body).toContain('mcp_upstream_healthy{state="unconfigured"} 3');
		expect(body).toContain('mcp_active_sessions 11');
		status.upstreamsHealthy = 0;
		status.upstreamsDegraded = 0;
		status.upstreamsDown = 0;
		status.upstreamsUnconfigured = 0;
		status.activeSessions = 0;
	});

	test('pool and catalog state are reported when provided', async () => {
		const metrics = createMetrics({ includeDefaults: false });
		metrics.refreshGauges({
			pool: { stats: () => ({ live: 4, maxLive: 20, pinned: 2, lazy: 2, bySlug: {} }) } as never,
			catalog: {
				stats: () => ({
					cached: [
						{ slug: 'github', tools: 12, ageMs: 1_500 },
						{ slug: 'broken', tools: 0, ageMs: 2_000, error: 'spawn failed' }
					],
					profiles: 3
				})
			} as never
		});
		const body = await text(metrics);
		expect(body).toContain('mcp_pooled_upstreams 4');
		expect(body).toContain('mcp_catalog_upstreams{slug="github",state="ok"} 1500');
		expect(body).toContain('mcp_catalog_upstreams{slug="broken",state="error"} 2000');
	});

	test('build info carries app and version', async () => {
		const metrics = createMetrics({ includeDefaults: false, appName: 'mcp-gateway-test' });
		expect(await text(metrics)).toContain('mcp_build_info{app="mcp-gateway-test",version="');
	});
});

describe('isolation', () => {
	test('each registry counts on its own', async () => {
		const a = createMetrics({ includeDefaults: false });
		const b = createMetrics({ includeDefaults: false });
		a.recordCall({ upstream: 'u', tool: 't', status: 'ok', durationMs: 1 });
		expect(await text(a)).toContain('mcp_tool_calls_total{upstream="u",tool="t",status="ok"} 1');
		expect(await text(b)).not.toContain(
			'mcp_tool_calls_total{upstream="u",tool="t",status="ok"} 1'
		);
	});
});
