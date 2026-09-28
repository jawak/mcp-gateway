import { describe, expect, test } from 'bun:test';
import { createFetchHandler, type RequestContext } from '../../src/handle';

function router(
	overrides: {
		sveltekit?: (request: Request, context: RequestContext) => Promise<Response>;
		mcp?: (request: Request, context: RequestContext) => Promise<Response>;
		maxBodyBytes?: number;
		healthz?: () => Record<string, unknown>;
	} = {}
) {
	return createFetchHandler({
		sveltekit:
			overrides.sveltekit ??
			(async (request) =>
				new Response(`sveltekit:${new URL(request.url).pathname}`, { status: 200 })),
		...(overrides.mcp ? { mcp: overrides.mcp } : {}),
		// a snapshot, not the global: bun runs test files in one process and the file
		// order differs per machine, so a sweep test running first would leave counters
		// set and this file's healthz assertions would fail on CI while passing locally
		healthz:
			overrides.healthz ??
			(() => ({
				ok: true,
				version: '0.0.1-test',
				uptime_s: 0,
				sessions: 0,
				upstreams: { live: 0, healthy: 0, degraded: 0, down: 0, unconfigured: 0 },
				last_health_sweep: null
			})),
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
	test('is closed (404) until a scrape token is configured', async () => {
		const res = await router()(new Request(url('/metrics')));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('not_found');
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

	test('a declared content-length above the limit is rejected with 413', async () => {
		const res = await router({ maxBodyBytes: 16 })(
			new Request(url('/mcp'), {
				method: 'POST',
				headers: { 'content-length': '64' },
				body: 'x'.repeat(64)
			})
		);
		expect(res.status).toBe(413);
		expect(((await res.json()) as { error: string }).error).toBe('payload_too_large');
	});

	test('a chunked body that outgrows the limit fails while the endpoint reads it', async () => {
		const { PayloadTooLargeError } = await import('../../src/lib/server/http/bridge');
		let seen: Error | undefined;
		const handle = router({
			maxBodyBytes: 32,
			mcp: async (request) => {
				try {
					await request.arrayBuffer();
					return new Response('read everything');
				} catch (error) {
					seen = error as Error;
					throw error;
				}
			}
		});
		// no content-length: the counting stream is the only thing that can catch this
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let index = 0; index < 10; index += 1)
					controller.enqueue(new Uint8Array(16).fill(120));
				controller.close();
			}
		});
		const request = new Request(url('/mcp'), {
			method: 'POST',
			body: stream,
			duplex: 'half'
		} as RequestInit);
		await expect(handle(request)).rejects.toBeInstanceOf(PayloadTooLargeError);
		expect(seen).toBeInstanceOf(PayloadTooLargeError);
	});

	test('the mcp endpoint receives the request and its context', async () => {
		const seen: Array<{ method: string; requestId: string; address: string }> = [];
		const handle = router({
			mcp: async (request, context) => {
				seen.push({
					method: request.method,
					requestId: context.requestId,
					address: context.clientAddress
				});
				return new Response('ok');
			}
		});
		const res = await handle(new Request(url('/mcp'), { method: 'POST', body: '{}' }));
		expect(res.status).toBe(200);
		expect(seen).toEqual([{ method: 'POST', requestId: seen[0]?.requestId, address: 'unknown' }]);
		expect(seen[0]?.requestId).toMatch(/[0-9a-f-]{36}/);
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
