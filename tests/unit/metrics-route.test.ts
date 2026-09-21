import { describe, expect, test } from 'bun:test';
import { createFetchHandler } from '../../src/handle';

const sveltekit = async () => new Response('app');

/** Router with a metrics route bound to a fake exposition + a scrape counter. */
function routerFor(token?: string) {
	let scrapes = 0;
	const handle = createFetchHandler({
		sveltekit,
		version: 'test',
		trustProxy: true,
		...(token === undefined
			? {}
			: {
					metrics: {
						expose: async () => {
							scrapes += 1;
							return '# HELP mcp_upstream_healthy Upstreams by health state\n# TYPE mcp_upstream_healthy gauge\nmcp_upstream_healthy{state="healthy"} 3\n';
						},
						token
					}
				})
	});
	return { handle, scrapes: () => scrapes };
}

const withToken = (token: string) =>
	new Request('http://localhost/metrics', { headers: { authorization: `Bearer ${token}` } });

describe('/metrics route', () => {
	test('is not exposed at all when no token is configured', async () => {
		const { handle } = routerFor();
		const res = await handle(new Request('http://localhost/metrics'));
		expect(res.status).toBe(404);
	});

	test('a missing or wrong token is 401 with a Bearer challenge', async () => {
		const { handle } = routerFor('s3cr3t-token');
		expect((await handle(new Request('http://localhost/metrics'))).status).toBe(401);
		const wrong = await handle(
			new Request('http://localhost/metrics', { headers: { authorization: 'Bearer nope' } })
		);
		expect(wrong.status).toBe(401);
		expect(wrong.headers.get('www-authenticate')).toContain('Bearer');
	});

	test('the right token returns the Prometheus exposition', async () => {
		const { handle } = routerFor('s3cr3t-token');
		const res = await handle(withToken('s3cr3t-token'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/plain');
		expect(await res.text()).toContain('mcp_upstream_healthy{state="healthy"} 3');
	});

	test('the exposition is produced at scrape time', async () => {
		const { handle, scrapes } = routerFor('t');
		expect(scrapes()).toBe(0);
		await handle(withToken('t'));
		await handle(withToken('t'));
		expect(scrapes()).toBe(2);
	});

	test('the metrics route never reaches the app handler', async () => {
		let appCalls = 0;
		const handle = createFetchHandler({
			sveltekit: async () => {
				appCalls += 1;
				return new Response('app');
			},
			metrics: { expose: async () => 'ok', token: 't' }
		});
		await handle(withToken('t'));
		expect(appCalls).toBe(0);
	});
});
