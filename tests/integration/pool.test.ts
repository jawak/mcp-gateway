/**
 * Upstream pool tests (T-08).
 *
 * A scripted fake handle keeps the lifecycle/LRU/semaphore assertions fast and
 * deterministic; one real stdio fixture proves no child process survives
 * `closeAll()`.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { UpstreamPool, type PoolOptions } from '../../src/lib/server/upstream/pool';
import type { UpstreamHandle, UpstreamRecord } from '../../src/lib/server/upstream/types';
import { connectStdio } from '../../src/lib/server/upstream/stdio';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { useDatabaseForTests } from '../../src/lib/server/db';
import { uuidv7 } from '../../src/lib/shared/ids';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'echo-mcp-server.ts');

function record(slug: string, overrides: Partial<UpstreamRecord> = {}): UpstreamRecord {
	return {
		id: uuidv7(),
		slug,
		name: slug,
		transport: 'stdio',
		enabled: true,
		connection: { command: process.execPath, args: [FIXTURE] },
		envRefs: {},
		timeoutMs: 5_000,
		pin: 'lazy',
		...overrides
	};
}

type Fake = UpstreamHandle & { connectCount: () => number; closeCount: () => number };

function fakeHandle(
	slug: string,
	options: { connectMs?: number; callMs?: number } = {}
): {
	handle: Fake;
	opens: () => number;
	closes: () => number;
} {
	let opens = 0;
	let closes = 0;
	let connected = false;
	let inFlight = 0;
	const handle = {
		slug,
		transport: 'stdio' as const,
		get connected() {
			return connected;
		},
		get inFlight() {
			return inFlight;
		},
		async ensureAlive() {
			if (connected) return;
			if (options.connectMs) await sleep(options.connectMs);
			opens += 1;
			connected = true;
		},
		async close(closeOptions: { graceMs?: number } = {}) {
			// honour the grace window the way the real transports do (BR-12)
			const deadline = Date.now() + (closeOptions.graceMs ?? 0);
			while (inFlight > 0 && Date.now() < deadline) await sleep(20);
			connected = false;
			closes += 1;
		},
		diagnostics: () => ({ spawnCount: opens }),
		client: () => ({}) as never,
		async listTools() {
			return { tools: [{ name: 'echo' }] };
		},
		async callTool(name: string, args: Record<string, unknown> | undefined) {
			inFlight += 1;
			try {
				if (options.callMs) await sleep(options.callMs);
				return {
					content: [
						{ type: 'text', text: `${name}:${String((args as { text?: string })?.text ?? '')}` }
					]
				};
			} finally {
				inFlight -= 1;
			}
		},
		async listResources() {
			return { resources: [] };
		},
		async readResource() {
			return { contents: [] };
		},
		async listPrompts() {
			return { prompts: [] };
		},
		async getPrompt() {
			return { messages: [] };
		},
		async ping() {
			return { latencyMs: 1 };
		}
	} as unknown as Fake;
	return { handle, opens: () => opens, closes: () => closes };
}

function poolFor(
	factories: Record<string, ReturnType<typeof fakeHandle>>,
	options: Partial<PoolOptions> = {}
): UpstreamPool {
	return new UpstreamPool({
		maxLive: options.maxLive ?? 10,
		idleTtlMs: options.idleTtlMs ?? 50,
		concurrencyPerUpstream: options.concurrencyPerUpstream ?? 2,
		queueWaitMs: options.queueWaitMs ?? 500,
		closeGraceMs: options.closeGraceMs ?? 2_000,
		connect: async (rec) => {
			const factory = factories[rec.slug];
			if (!factory) throw new Error(`no factory for ${rec.slug}`);
			// real transports connect before resolving; mirror that so counters match
			await factory.handle.ensureAlive();
			return factory.handle;
		},
		...options
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('pool — reuse', () => {
	test('get() twice returns one connection', async () => {
		const factories = { a: fakeHandle('a') };
		const pool = poolFor(factories);
		const first = await pool.get(record('a'));
		const second = await pool.get(record('a'));
		expect(second).toBe(first);
		expect(factories.a.opens()).toBe(1);
		expect(pool.size).toBe(1);
		await pool.closeAll(0);
	});

	test('concurrent get() for the same slug connects once', async () => {
		const factories = { slow: fakeHandle('slow', { connectMs: 60 }) };
		const pool = poolFor(factories);
		const handles = await Promise.all([
			pool.get(record('slow')),
			pool.get(record('slow')),
			pool.get(record('slow'))
		]);
		expect(new Set(handles).size).toBe(1);
		expect(factories.slow.opens()).toBe(1);
		await pool.closeAll(0);
	});

	test('a changed connection string forces a reconnect', async () => {
		const factories = { a: fakeHandle('a') };
		const pool = poolFor(factories);
		await pool.get(record('a', { connection: { command: 'one' } }));
		await pool.get(record('a', { connection: { command: 'two' } }));
		expect(factories.a.opens()).toBe(2);
		expect(factories.a.closes()).toBe(1);
		await pool.closeAll(0);
	});

	test('a disabled upstream is refused without connecting', async () => {
		const factories = { off: fakeHandle('off') };
		const pool = poolFor(factories);
		await expect(pool.get(record('off', { enabled: false }))).rejects.toThrow(/disabled/);
		expect(factories.off.opens()).toBe(0);
		await pool.closeAll(0);
	});
});

describe('pool — capacity and idle', () => {
	test('idle lazy connections are swept, then reopened on demand', async () => {
		const factories = { a: fakeHandle('a') };
		const pool = poolFor(factories, { idleTtlMs: 30 });
		await pool.get(record('a', { pin: 'lazy' }));
		await sleep(60);
		expect(await pool.sweepIdle()).toEqual(['a']);
		expect(factories.a.closes()).toBe(1);
		expect(pool.size).toBe(0);

		await pool.get(record('a', { pin: 'lazy' }));
		expect(factories.a.opens()).toBe(2);
		await pool.closeAll(0);
	});

	test('pinned upstreams are never swept', async () => {
		const factories = { keep: fakeHandle('keep') };
		const pool = poolFor(factories, { idleTtlMs: 20 });
		await pool.get(record('keep', { pin: 'pinned' }));
		await sleep(60);
		expect(await pool.sweepIdle()).toEqual([]);
		expect(pool.size).toBe(1);
		await pool.closeAll(0);
	});

	test('at capacity the least-recently-used lazy upstream is evicted', async () => {
		const factories = { x: fakeHandle('x'), y: fakeHandle('y'), z: fakeHandle('z') };
		const pool = poolFor(factories, { maxLive: 2, idleTtlMs: 100_000 });
		await pool.get(record('x'));
		await sleep(10);
		await pool.get(record('y'));
		await pool.get(record('x')); // x becomes the most recently used
		await pool.get(record('z')); // y must go

		expect(pool.liveSlugs().sort()).toEqual(['x', 'z']);
		expect(factories.y.closes()).toBe(1);
		expect(factories.x.opens()).toBe(1);
		await pool.closeAll(0);
	});

	test('warm() only touches enabled pinned upstreams and reports failures', async () => {
		const factories = { ok: fakeHandle('ok'), bad: fakeHandle('bad') };
		const pool = new UpstreamPool({
			connect: async (rec) => {
				if (rec.slug === 'bad') throw new Error('spawn failed');
				return factories.ok.handle;
			}
		});
		const result = await pool.warm([
			record('ok', { pin: 'pinned' }),
			record('bad', { pin: 'pinned' }),
			record('lazy-one'),
			record('disabled', { pin: 'pinned', enabled: false })
		]);
		expect(result.warmed).toEqual(['ok']);
		expect(result.failed).toEqual([{ slug: 'bad', error: 'spawn failed' }]);
		await pool.closeAll(0);
	});

	test('an idle sweeper runs in the background and can be stopped', async () => {
		const factories = { a: fakeHandle('a') };
		const pool = poolFor(factories, { idleTtlMs: 10 });
		await pool.get(record('a', { pin: 'lazy' }));
		pool.startIdleSweeper(20);
		await sleep(80);
		expect(pool.size).toBe(0);
		pool.startIdleSweeper(20); // idempotent
		pool.stopIdleSweeper();
		await pool.closeAll(0);
	});
});

describe('pool — concurrency', () => {
	test('at most N calls run concurrently per upstream', async () => {
		const factories = { a: fakeHandle('a', { callMs: 60 }) };
		const pool = poolFor(factories, { concurrencyPerUpstream: 2 });
		let running = 0;
		let peak = 0;
		const job = () =>
			pool.withHandle(record('a'), async (handle) => {
				running += 1;
				peak = Math.max(peak, running);
				await handle.callTool('echo', { text: 'x' });
				running -= 1;
			});
		await Promise.all([job(), job(), job(), job(), job()]);
		expect(peak).toBe(2);
		await pool.closeAll(0);
	});

	test('callers waiting too long are rejected, later callers still get through', async () => {
		const factories = { a: fakeHandle('a', { callMs: 400 }) };
		const pool = poolFor(factories, { concurrencyPerUpstream: 1, queueWaitMs: 60 });
		const hog = pool.withHandle(record('a'), (handle) => handle.callTool('slow', { ms: 400 }));
		await sleep(10);
		await expect(
			pool.withHandle(record('a'), (h) => h.callTool('echo', { text: 'q' }))
		).rejects.toThrow(/busy/);
		await hog;
		// the slot is free again
		expect(
			await pool.withHandle(record('a'), (h) => h.callTool('echo', { text: 'after' }))
		).toBeTruthy();
		await pool.closeAll(0);
	});

	test('queued callers are released with an error when the upstream closes', async () => {
		const factories = { a: fakeHandle('a', { callMs: 300 }) };
		const pool = poolFor(factories, { concurrencyPerUpstream: 1, queueWaitMs: 5_000 });
		const hog = pool.withHandle(record('a'), (h) => h.callTool('slow', { ms: 300 }));
		await sleep(10);
		// settle to a value first: the caller must see the failure as a rejection
		const queuedOutcome = pool
			.withHandle(record('a'), (h) => h.callTool('echo', { text: 'q' }))
			.then(
				() => 'resolved',
				(error: Error) => error.message
			);
		await sleep(10);
		expect(await pool.close('a', { graceMs: 1_000 })).toBe(true);
		expect(await queuedOutcome).toMatch(/closed/);
		await hog;
		await pool.closeAll(0);
	});
});

describe('pool — shutdown', () => {
	test('close() waits for the in-flight call before releasing', async () => {
		const factories = { a: fakeHandle('a', { callMs: 200 }) };
		const pool = poolFor(factories, { concurrencyPerUpstream: 2 });
		await pool.get(record('a'));
		const started = Date.now();
		const call = pool.withHandle(record('a'), (h) => h.callTool('slow', { ms: 200 }));
		await sleep(20);
		await pool.close('a', { graceMs: 3_000 });
		expect(Date.now() - started).toBeGreaterThanOrEqual(150);
		await call;
		expect(pool.size).toBe(0);
		await pool.closeAll(0);
	});

	test('get() after closeAll() is refused (no new children during shutdown)', async () => {
		const factories = { a: fakeHandle('a') };
		const pool = poolFor(factories);
		await pool.get(record('a'));
		await pool.closeAll(0);
		await expect(pool.get(record('a'))).rejects.toThrow(/shutting down/);
	});

	test('stats() reports live connections per slug', async () => {
		const factories = { a: fakeHandle('a'), b: fakeHandle('b') };
		const pool = poolFor(factories);
		await pool.get(record('a', { pin: 'pinned' }));
		await pool.get(record('b', { pin: 'lazy' }));
		const stats = pool.stats();
		expect(stats).toMatchObject({ live: 2, pinned: 1, lazy: 1 });
		expect(stats.bySlug.a?.transport).toBe('stdio');
		expect(stats.bySlug.a?.connected).toBe(true);
		await pool.closeAll(0);
	});

	test('peek() never connects', async () => {
		const factories = { a: fakeHandle('a') };
		const pool = poolFor(factories);
		expect(pool.peek('a')).toBeUndefined();
		await pool.get(record('a'));
		expect(pool.peek('a')?.slug).toBe('a');
		expect(factories.a.opens()).toBe(1);
		await pool.closeAll(0);
	});

	test('close() on an unknown slug is a no-op', async () => {
		const pool = poolFor({});
		expect(await pool.close('ghost')).toBe(false);
		await pool.closeAll(0);
	});
});

describe('pool — real child processes', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-pool-'));

	test('no child process survives closeAll()', async () => {
		process.env.MCPGW_DATA_DIR = dir;
		process.env.MCPGW_MASTER_KEY = 'e'.repeat(64);
		runMigrations({ dataDir: dir });
		useDatabaseForTests(path.join(dir, 'mcpgw.db'));

		const pool = new UpstreamPool({ maxLive: 4, connect: (rec) => connectStdio({ record: rec }) });
		const handle = (await pool.get(record('live'))) as UpstreamHandle;
		expect(JSON.stringify((await handle.callTool('echo', { text: 'real' })).content)).toContain(
			'echo:real'
		);
		expect(pool.size).toBe(1);

		await pool.closeAll(2_000);

		// the [e] bracket stops grep from matching its own `sh -c` argument line
		const probe = Bun.spawnSync([
			'sh',
			'-c',
			'ps -eo pid,args | grep "[e]cho-mcp-server.ts" || true'
		]);
		const survivors = probe.stdout
			.toString()
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		if (survivors.length > 0) console.log('SURVIVOR LINES:', JSON.stringify(survivors));
		expect(survivors).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});
});
