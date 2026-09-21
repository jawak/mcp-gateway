/**
 * Load and latency measurement (T-44).
 *
 * Measures what the PRD commits to, against a running instance:
 *   - `tools/list` cache-hit latency
 *   - *added* latency of routing a tool call, computed as gateway round trip minus
 *     the same call against the same server reached directly, so upstream work is
 *     not charged to the gateway
 *   - concurrent SSE sessions
 *   - rate-limit behaviour under a burst
 *
 * Provisions its own upstream/profile/key through the admin console, so it is
 * runnable against any instance with the bootstrap credentials.
 *
 * Usage: bun run scripts/loadtest.ts --base-url http://localhost:8080 [--sessions 200]
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { resolve } from 'node:path';
import { createConsole } from './lib/console.ts';
import { startFixtureHttpServer } from '../tests/fixtures/http-mcp-server.ts';

const args = process.argv.slice(2);
function arg(name: string, fallback: string): string {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
}

const base = arg('base-url', 'http://localhost:8080').replace(/\/$/, '');
const sessions = Number.parseInt(arg('sessions', '200'), 10);
const burst = Number.parseInt(arg('burst', '300'), 10);
const email = arg('smoke-email', 'admin@example.com');
const password = arg('smoke-password', 'bootstrap-pass-123');
const fixturePort = Number.parseInt(arg('fixture-port', '4599'), 10);
const fixture = resolve(import.meta.dirname, '../tests/fixtures/echo-mcp-server.ts');
const slug = `load-${Math.random().toString(36).slice(2, 7)}`;

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function report(
	label: string,
	samples: number[],
	target?: { p50?: number; p95?: number }
): boolean {
	const sorted = [...samples].sort((a, b) => a - b);
	const p50 = percentile(sorted, 0.5);
	const p95 = percentile(sorted, 0.95);
	const p99 = percentile(sorted, 0.99);
	const within =
		target === undefined || ((target.p50 ?? Infinity) >= p50 && (target.p95 ?? Infinity) >= p95);
	const note = target === undefined ? '' : within ? '  ✓ within target' : '  ✗ OVER TARGET';
	console.log(
		`  ${label.padEnd(36)} p50 ${p50.toFixed(1)}  p95 ${p95.toFixed(1)}  p99 ${p99.toFixed(1)} ms  n=${samples.length}${note}`
	);
	return within;
}

async function main(): Promise<void> {
	console.log(`loadtest: ${base} (sessions=${sessions}, burst=${burst})`);
	const console_ = createConsole({ base, email, password });
	await console_.signIn();
	const created = await console_.createUpstream({
		slug,
		name: 'Load host',
		command: process.execPath,
		args: fixture
	});
	if (!created.ok) throw new Error(`upstream not healthy: ${created.location}`);
	// Two profiles on purpose: the load key needs headroom so the measurement is of
	// the gateway, not of its own limiter; the throttle key stays deliberately small
	// so the final phase can prove the limiter actually refuses.
	const loadProfileId = await console_.createProfile({
		name: `load-${slug}`,
		slug,
		rateLimitRpm: 20_000,
		dailyCallQuota: 500_000
	});
	const apiKey = await console_.createKey({ name: 'load-key', profileId: loadProfileId });
	if (!apiKey) throw new Error('no API key returned');

	const connect = () => console_.mcpClient(apiKey);
	const primary = await connect();
	await primary.client.listTools(); // warm the catalog: measure the steady state

	const results: boolean[] = [];

	// 1. tools/list cache hit
	const listSamples: number[] = [];
	for (let index = 0; index < 30; index += 1) {
		const started = performance.now();
		await primary.client.listTools();
		listSamples.push(performance.now() - started);
	}
	results.push(report('tools/list (cache hit)', listSamples, { p95: 100 }));

	// 2. added latency: same server, reached through the gateway and directly
	const fixtureServer = await startFixtureHttpServer({ port: fixturePort });
	const direct = new Client({ name: 'direct', version: '1.0.0' }, { capabilities: {} });
	await direct.connect(new StreamableHTTPClientTransport(new URL(fixtureServer.url)));

	const echo = (await primary.client.listTools()).tools.find((tool) =>
		tool.name.endsWith('__echo')
	);
	if (!echo) throw new Error('fixture echo tool missing');

	const gateway: number[] = [];
	const directSamples: number[] = [];
	for (let index = 0; index < 40; index += 1) {
		const startedA = performance.now();
		await primary.client.callTool({ name: echo.name, arguments: { text: 'x' } });
		gateway.push(performance.now() - startedA);

		const startedB = performance.now();
		await direct.callTool({ name: 'echo', arguments: { text: 'x' } });
		directSamples.push(performance.now() - startedB);
	}
	const added = gateway.map((value, index) => Math.max(0, value - (directSamples[index] ?? 0)));
	report('tools/call via gateway', gateway);
	report('tools/call direct to upstream', directSamples);
	results.push(report('added latency (gateway - direct)', added, { p50: 100, p95: 300 }));

	// 3. concurrent sessions
	const opened = performance.now();
	const pool = await Promise.all(
		Array.from({ length: sessions }, async () => {
			const session = await connect();
			await session.client.listTools();
			return session;
		})
	);
	const openedMs = performance.now() - opened;
	console.log(
		`  ${'sessions opened'.padEnd(36)} ${pool.length} in ${openedMs.toFixed(0)} ms (${((pool.length / openedMs) * 1000).toFixed(0)}/s)`
	);
	const concurrent: number[] = [];
	await Promise.all(
		pool.map(async (session) => {
			const started = performance.now();
			await session.client.listTools();
			concurrent.push(performance.now() - started);
		})
	);
	results.push(report('tools/list at full concurrency', concurrent, { p95: 100 }));
	await Promise.all(pool.map((session) => session.close()));

	// 4. burst against the rate limiter, on a key whose profile is deliberately tight
	const tightProfileId = await console_.createProfile({
		name: `throttle-${slug}`,
		slug,
		rateLimitRpm: 30,
		dailyCallQuota: 100_000
	});
	const tightKey = await console_.createKey({ name: 'throttle-key', profileId: tightProfileId });
	if (!tightKey) throw new Error('no throttle key returned');
	const statuses = await Promise.all(
		Array.from({ length: burst }, async () =>
			fetch(`${base}/mcp`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					authorization: `Bearer ${tightKey}`
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
			}).then((response) => response.status)
		)
	);
	const limited = statuses.filter((status) => status === 429).length;
	const authErrors = statuses.filter((status) => status === 401 || status === 403).length;
	// full histogram: a burst that returns "none of the expected codes" is itself a finding
	const histogram = statuses.reduce<Record<string, number>>((tally, status) => {
		tally[String(status)] = (tally[String(status)] ?? 0) + 1;
		return tally;
	}, {});
	console.log(
		`  ${`burst of ${burst} requests`.padEnd(36)} ${new URLSearchParams(histogram).toString().replace(/&/g, ' ')}`
	);
	results.push(limited > 0 && authErrors === 0);
	if (limited === 0)
		console.log('  ✗ rate limiter never triggered — raise --burst or lower the profile limit');

	const rss = process.memoryUsage().rss / 1_048_576;
	console.log(`  ${'loadtest RSS'.padEnd(36)} ${rss.toFixed(0)} MB (gateway RSS: see /metrics)`);

	await direct.close();
	fixtureServer.stop();
	await primary.client.close();

	const failed = results.filter((ok) => !ok).length;
	console.log(`\n${results.length - failed}/${results.length} targets met`);
	if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
	console.error('loadtest aborted:', error instanceof Error ? error.stack : error);
	process.exit(1);
});
