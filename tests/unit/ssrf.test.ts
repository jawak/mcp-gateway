import { describe, expect, test } from 'bun:test';
import {
	assertUrlAllowed,
	classifyAddress,
	createSsrfSafeFetch,
	SsrfError
} from '../../src/lib/server/security/ssrf';

const resolve =
	(...addresses: string[]) =>
	async (): Promise<Array<{ address: string }>> =>
		addresses.map((address) => ({ address }));

describe('classifyAddress', () => {
	type Kind = ReturnType<typeof classifyAddress>;
	const cases: Array<[string, Kind]> = [
		['127.0.0.1', 'loopback'],
		['127.9.9.9', 'loopback'],
		['::1', 'loopback'],
		['10.1.2.3', 'private'],
		['172.16.0.1', 'private'],
		['172.32.0.1', 'public'],
		['192.168.1.254', 'private'],
		['100.64.0.1', 'private'],
		['169.254.169.254', 'link-local'],
		['fe80::1', 'link-local'],
		['fd12::1', 'private'],
		['ff02::1', 'multicast'],
		['224.0.0.5', 'multicast'],
		['8.8.8.8', 'public'],
		['2606:4700:4700::1111', 'public'],
		['::ffff:192.168.0.1', 'private']
	];
	for (const [address, expected] of cases) {
		test(`${address} → ${expected}`, () => {
			expect(classifyAddress(address)).toBe(expected);
		});
	}
});

describe('assertUrlAllowed', () => {
	test('accepts a public https MCP endpoint', async () => {
		const { url, addresses } = await assertUrlAllowed('https://mcp.github.com/sse?x=1', {
			resolve: resolve('140.82.112.22')
		});
		expect(url.hostname).toBe('mcp.github.com');
		expect(addresses).toEqual(['140.82.112.22']);
	});

	test('rejects non-http(s) schemes and garbage', async () => {
		await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toThrow(/unsupported protocol/);
		await expect(assertUrlAllowed('gopher://10.0.0.1:70/')).rejects.toThrow(/unsupported protocol/);
		await expect(assertUrlAllowed('not a url')).rejects.toThrow(/not a valid absolute URL/);
	});

	test('rejects credentials embedded in the URL', async () => {
		await expect(
			assertUrlAllowed('https://admin:password@mcp.example.com/', {
				resolve: resolve('93.184.216.34')
			})
		).rejects.toThrow(/credentials in the URL/);
	});

	test('refuses http:// to anything but loopback', async () => {
		await expect(
			assertUrlAllowed('http://mcp.example.com/mcp', { resolve: resolve('93.184.216.34') })
		).rejects.toThrow(/http:\/\/ is refused/);
		await expect(assertUrlAllowed('http://127.0.0.1:3000/mcp')).resolves.toMatchObject({
			url: { hostname: '127.0.0.1' }
		});
		await expect(
			assertUrlAllowed('http://localhost:3000/mcp', { resolve: resolve('127.0.0.1') })
		).resolves.toBeTruthy();
	});

	test('blocks the cloud metadata address', async () => {
		await expect(
			assertUrlAllowed('https://metadata.internal./', { resolve: resolve('169.254.169.254') })
		).rejects.toThrow(/link-local/);
		await expect(assertUrlAllowed('https://evil.example.com/')).rejects.toBeInstanceOf(Error);
	});

	test('blocks private ranges unless explicitly allowed', async () => {
		await expect(
			assertUrlAllowed('https://db.internal.example/', { resolve: resolve('10.20.30.40') })
		).rejects.toThrow(/private range/);
		await expect(
			assertUrlAllowed('https://db.internal.example/', {
				resolve: resolve('10.20.30.40'),
				allowPrivateNetwork: true
			})
		).resolves.toBeTruthy();
	});

	test('blocks when ANY answer is internal (multi-record DNS)', async () => {
		await expect(
			assertUrlAllowed('https://both.example/', {
				resolve: resolve('93.184.216.34', '192.168.0.7')
			})
		).rejects.toThrow(/private range/);
	});

	test('literal IPs are classified without DNS', async () => {
		await expect(assertUrlAllowed('https://[fd12::1]/mcp')).rejects.toThrow(/private range/);
		await expect(assertUrlAllowed('https://169.254.169.254/')).rejects.toThrow(/link-local/);
	});

	test('localhost must resolve to loopback (no rebind to a routable host)', async () => {
		await expect(
			assertUrlAllowed('http://localhost:3000/mcp', { resolve: resolve('93.184.216.34') })
		).rejects.toThrow(/non-loopback/);
		await expect(
			assertUrlAllowed('http://localhost:3000/mcp', { resolve: resolve('::1') })
		).resolves.toBeTruthy();
	});

	test('DNS failure and empty answers are reported', async () => {
		await expect(
			assertUrlAllowed('https://gone.example/', {
				resolve: async () => {
					throw new Error('ENOTFOUND');
				}
			})
		).rejects.toThrow(/DNS lookup failed/);
		await expect(
			assertUrlAllowed('https://empty.example/', { resolve: resolve() })
		).rejects.toThrow(/no addresses/);
	});

	test('SsrfError carries the offending url for the admin UI', async () => {
		try {
			await assertUrlAllowed('http://mcp.example.com/mcp', { resolve: resolve('93.184.216.34') });
			throw new Error('expected throw');
		} catch (error) {
			expect(error).toBeInstanceOf(SsrfError);
			expect((error as SsrfError).url).toContain('mcp.example.com');
		}
	});
});

describe('createSsrfSafeFetch', () => {
	test('never follows a redirect into the private network', async () => {
		const local = Bun.serve({
			port: 0,
			fetch() {
				return new Response('ok');
			}
		});
		try {
			const safe = createSsrfSafeFetch({ timeoutMs: 2000 });
			const direct = await safe(`http://127.0.0.1:${local.port}/mcp`);
			expect(await direct.text()).toBe('ok');

			const redirecting = Bun.serve({
				port: 0,
				fetch() {
					return new Response(null, {
						status: 302,
						headers: { location: 'http://169.254.169.254/' }
					});
				}
			});
			try {
				await expect(safe(`http://127.0.0.1:${redirecting.port}/`)).rejects.toThrow(/redirect/i);
			} finally {
				redirecting.stop(true);
			}
		} finally {
			local.stop(true);
		}
	});

	test('blocked destinations never reach the network', async () => {
		const safe = createSsrfSafeFetch({ resolve: resolve('10.0.0.1') });
		await expect(safe('https://internal.example/mcp')).rejects.toThrow(/private range/);
	});
});
