/**
 * Rate limit, quota and concurrency tests (T-23).
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
	BusyError,
	DEFAULT_LIMITS,
	RateLimiter,
	type Limits
} from '../../src/lib/server/governance/ratelimit';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { useDatabaseForTests, getDb } from '../../src/lib/server/db/index.ts';
import { kv } from '../../src/lib/server/db/schema.ts';
import { eq } from 'drizzle-orm';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-rl-'));
process.env.MCPGW_DATA_DIR = dir;
process.env.MCPGW_MASTER_KEY = '7'.repeat(64);
runMigrations({ dataDir: dir });
useDatabaseForTests(path.join(dir, 'mcpgw.db'));

const limits = (overrides: Partial<Limits> = {}): Limits => ({ ...DEFAULT_LIMITS, ...overrides });

describe('request budget (token bucket)', () => {
	let limiter: RateLimiter;
	beforeEach(() => {
		limiter = new RateLimiter({ queueWaitMs: 200 });
	});

	test('121 requests in one minute at a limit of 120: the last one is refused', () => {
		const now = 1_000_000;
		let allowed = 0;
		for (let index = 0; index < 121; index += 1) {
			if (limiter.takeRequest('key-a', limits({ rateLimitRpm: 120 }), now).ok) allowed += 1;
		}
		expect(allowed).toBe(120);
	});

	test('a refusal carries a retry window and the remainder', () => {
		const now = 2_000_000;
		for (let index = 0; index < 5; index += 1)
			limiter.takeRequest('key-b', limits({ rateLimitRpm: 5 }), now);
		const outcome = limiter.takeRequest('key-b', limits({ rateLimitRpm: 5 }), now);
		expect(outcome.ok).toBe(false);
		expect(outcome.remaining).toBe(0);
		expect(outcome.retryAfterMs).toBeGreaterThan(0);
		expect(outcome.retryAfterMs).toBeLessThanOrEqual(60_000);
	});

	test('tokens refill over time, capped at the limit', () => {
		const start = 3_000_000;
		for (let index = 0; index < 10; index += 1)
			limiter.takeRequest('key-c', limits({ rateLimitRpm: 10 }), start);
		expect(limiter.takeRequest('key-c', limits({ rateLimitRpm: 10 }), start + 100).ok).toBe(false);
		// 6 s at 10/min refills one token
		expect(limiter.takeRequest('key-c', limits({ rateLimitRpm: 10 }), start + 6_000).ok).toBe(true);
		// and the bucket never exceeds the configured capacity
		const later = start + 10 * 60_000;
		let allowed = 0;
		for (let index = 0; index < 25; index += 1)
			if (limiter.takeRequest('key-c', limits({ rateLimitRpm: 10 }), later).ok) allowed += 1;
		expect(allowed).toBe(10);
	});

	test('keys are isolated from each other', () => {
		const now = 4_000_000;
		limiter.takeRequest('busy-key', limits({ rateLimitRpm: 1 }), now);
		expect(limiter.takeRequest('busy-key', limits({ rateLimitRpm: 1 }), now).ok).toBe(false);
		expect(limiter.takeRequest('other-key', limits({ rateLimitRpm: 1 }), now).ok).toBe(true);
	});

	test('10k keys do not leak memory: idle state is swept away', () => {
		const fresh = new RateLimiter({ queueWaitMs: 100 });
		const start = 5_000_000;
		for (let index = 0; index < 10_000; index += 1)
			fresh.takeRequest(`key-${index}`, limits({ rateLimitRpm: 5 }), start);
		expect(fresh.stats().buckets).toBeGreaterThan(0);
		// long after the eviction window, every bucket is collectable
		for (let index = 0; index < 10_000; index += 1)
			fresh.takeRequest('hot-key', limits({ rateLimitRpm: 5 }), start + 60 * 60_000);
		expect(fresh.stats().buckets).toBeLessThan(10_000);
	});
});

describe('daily quota', () => {
	test('calls are counted and refused at the cap', () => {
		const limiter = new RateLimiter({ queueWaitMs: 100 });
		for (let index = 0; index < 5; index += 1) {
			expect(limiter.hasDailyQuota('quota-key', limits({ dailyCallQuota: 5 }))).toBe(true);
			limiter.consumeDaily('quota-key');
		}
		expect(limiter.hasDailyQuota('quota-key', limits({ dailyCallQuota: 5 }))).toBe(false);
		expect(limiter.dailyUsed('quota-key')).toBe(5);
	});

	test('an unlimited quota never blocks', () => {
		const limiter = new RateLimiter({ queueWaitMs: 100 });
		for (let index = 0; index < 50; index += 1) limiter.consumeDaily('unlimited');
		expect(limiter.hasDailyQuota('unlimited', limits({ dailyCallQuota: 0 }))).toBe(true);
	});

	test('used quota is flushed to kv so a restart does not reset the day', () => {
		const limiter = new RateLimiter({ queueWaitMs: 100 });
		for (let index = 0; index < 20; index += 1) limiter.consumeDaily('flush-key');
		const rows = getDb()
			.select()
			.from(kv)
			.where(eq(kv.key, `quota:${new Date().toISOString().slice(0, 10)}:flush-key`))
			.all();
		expect(rows).toHaveLength(1);
		expect(Number(rows[0]!.value)).toBe(20);

		// a new limiter (a process restart) reads the same number back
		const revived = new RateLimiter({ queueWaitMs: 100 });
		expect(revived.dailyUsed('flush-key')).toBe(20);
	});

	test('quota is tracked per key', () => {
		const limiter = new RateLimiter({ queueWaitMs: 100 });
		limiter.consumeDaily('one');
		expect(limiter.dailyUsed('two')).toBe(0);
		expect(limiter.dailyUsed('one')).toBe(1);
	});
});

describe('concurrency', () => {
	test('at most N slots run at once and the rest queue', async () => {
		const limiter = new RateLimiter({ queueWaitMs: 2_000 });
		const cap = limits({ maxConcurrency: 3 });
		const releases: Array<() => void> = [];
		for (let index = 0; index < 3; index += 1) releases.push(await limiter.acquire('conc', cap));
		expect(limiter.inFlight('conc')).toBe(3);

		let queuedResolved = false;
		const queued = limiter.acquire('conc', cap).then((release) => {
			queuedResolved = true;
			return release;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(queuedResolved).toBe(false);
		expect(limiter.stats().queued).toBe(1);

		releases[0]!();
		const queuedRelease = await queued;
		expect(queuedResolved).toBe(true);
		queuedRelease();
		releases.slice(1).forEach((release) => release());
		expect(limiter.inFlight('conc')).toBe(0);
	});

	test('waiting past the budget is a BusyError, not an unbounded queue', async () => {
		const limiter = new RateLimiter({ queueWaitMs: 60 });
		const cap = limits({ maxConcurrency: 1 });
		const release = await limiter.acquire('slow', cap);
		await expect(limiter.acquire('slow', cap)).rejects.toBeInstanceOf(BusyError);
		expect(limiter.stats().queued).toBe(0);
		release();
	});

	test('releasing twice does not grant an extra slot', async () => {
		const limiter = new RateLimiter({ queueWaitMs: 100 });
		const cap = limits({ maxConcurrency: 1 });
		const release = await limiter.acquire('double', cap);
		release();
		release();
		expect(limiter.inFlight('double')).toBe(0);
		// still exactly one slot available
		const first = await limiter.acquire('double', cap);
		await expect(limiter.acquire('double', limits({ maxConcurrency: 1 }))).rejects.toBeInstanceOf(
			BusyError
		);
		first();
	});
});

describe('response headers', () => {
	test('a refusal advertises Retry-After and the remaining budget', () => {
		const headers = RateLimiter.headers({ retryAfterMs: 2_500 }, 0);
		expect(headers['retry-after']).toBe('3');
		expect(headers['x-ratelimit-remaining']).toBe('0');
		expect(RateLimiter.headers({}, 7)['retry-after']).toBeUndefined();
		expect(RateLimiter.headers({}, -1)['x-ratelimit-remaining']).toBe('0');
	});
});

describe('defaults and cleanup', () => {
	test('documented defaults match the spec', () => {
		expect(DEFAULT_LIMITS).toEqual({
			rateLimitRpm: 120,
			dailyCallQuota: 1_000,
			maxConcurrency: 10
		});
	});

	test('forget() drops all state for a key', async () => {
		const limiter = new RateLimiter({ queueWaitMs: 100 });
		limiter.takeRequest('gone', limits());
		limiter.consumeDaily('gone');
		const release = await limiter.acquire('gone', limits());
		limiter.forget('gone');
		expect(limiter.dailyUsed('gone')).toBe(0);
		expect(limiter.inFlight('gone')).toBe(0);
		release();
		rmSync(dir, { recursive: true, force: true });
	});
});
