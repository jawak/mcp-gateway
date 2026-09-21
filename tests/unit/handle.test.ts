import { describe, expect, test } from 'vitest';
import { createFetchHandler } from '../../src/handle';

function router(
	overrides: {
		sveltekit?: (request: Request) => Promise<Response>;
		maxBodyBytes?: number;
	} = {}
) {
	return createFetchHandler({
		sveltekit:
			overrides.sveltekit ??
			(async (request) =>
				new Response(`sveltekit:${new URL(request.url).pathname}`, { status: 200 })),
		version: '0.0.1-test',
		trustProxy: true,
		maxBodyBytes: overrides.maxBodyBytes ?? 1_048_576
	});
}

const url = (path: string): string => `http://localhost:8080${path}`;

describe('/healthz', () => {
	test('reports gateway status as JSON', async () => {
		const res = await router()(new Request(url('/healthz')));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			ok: true,
			version: '0.0.1-test',
			sessions: 0,
			upstreams: { live: 0, healthy: 0, degraded: 0, down: 0, unconfigured: 0 }
		});
		expect(body.last_health_sweep).toBeNull();
		expect(typeof body.uptime_s).toBe('number');
	});
});

describe('/metrics', () => {
	test('returns 501 until T-26 mounts prom-client', async () => {
		const res = await router()(new Request(url('/metrics')));
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('not_implemented');
	});
});

describe('/mcp', () => {
	test('POST returns 503 not_mounted and drains the body', async () => {
		const res = await router()(
			new Request(url('/mcp'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })
			})
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('not_mounted');
	});

	test('POST above the body limit is rejected with 413', async () => {
		const res = await router({ maxBodyBytes: 16 })(
			new Request(url('/mcp'), { method: 'POST', body: 'x'.repeat(64) })
		);
		expect(res.status).toBe(413);
		expect(((await res.json()) as { error: string }).error).toBe('payload_too_large');
	});

	test('methods outside POST/GET/DELETE get 405 with an allow header', async () => {
		const res = await router()(new Request(url('/mcp'), { method: 'PUT' }));
		expect(res.status).toBe(405);
		expect(res.headers.get('allow')).toBe('POST, GET, DELETE');
	});

	test('trailing slash is normalised to the same route', async () => {
		const res = await router()(new Request(url('/mcp/'), { method: 'DELETE' }));
		expect(res.status).toBe(503);
	});
});

describe('routing', () => {
	test('unknown paths are delegated to SvelteKit', async () => {
		const res = await router()(new Request(url('/admin/keys')));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('sveltekit:/admin/keys');
	});

	test('every response carries X-Request-Id', async () => {
		const handle = router();
		const generated = await handle(new Request(url('/healthz')));
		expect(generated.headers.get('x-request-id')).toMatch(/[0-9a-f-]{36}/);
	});

	test('an inbound X-Request-Id is preserved', async () => {
		const res = await router()(
			new Request(url('/healthz'), { headers: { 'x-request-id': 'trace-abc' } })
		);
		expect(res.headers.get('x-request-id')).toBe('trace-abc');
	});
});
