/**
 * Rate limiting, daily quotas and concurrency (T-23).
 *
 * Three independent brakes, because they protect against different things:
 *
 *  - **Request budget** (token bucket, `rate_limit_rpm`): protects the gateway
 *    and the upstreams from a runaway agent loop.
 *  - **Daily quota** (`daily_call_quota`): caps total blast radius per key. Kept
 *    in memory and flushed to `kv` so the limit survives a restart, but a
 *    competitor racing a restart can only ever lose one day's worth of counting.
 *  - **Concurrency** (`max_concurrency`): the one that actually matters when an
 *    upstream is slow — a handful of hung tool calls must not occupy every worker
 *    slot. Waiters are queued fairly and rejected after `queueWaitMs` rather than
 *    piling up forever.
 *
 * Buckets and counters are evicted when a key has been idle for a while, so a
 * long-lived process cannot accumulate state for keys that no longer exist.
 */
import { eq } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.ts';
import { kv } from '../db/schema.ts';
import { dayBucket } from '../../shared/time.ts';

export type Limits = {
	/** Requests per minute allowed for this key. */
	rateLimitRpm: number;
	/** Tool calls allowed per UTC day. */
	dailyCallQuota: number;
	/** Simultaneous in-flight calls. */
	maxConcurrency: number;
};

export const DEFAULT_LIMITS: Limits = {
	rateLimitRpm: 120,
	dailyCallQuota: 1_000,
	maxConcurrency: 10
};

export type BudgetOutcome =
	| { ok: true; remaining: number; retryAfterMs?: undefined }
	| { ok: false; remaining: number; retryAfterMs: number };

export class BusyError extends Error {
	readonly retryAfterMs: number;

	constructor(message: string, retryAfterMs = 250) {
		super(message);
		this.name = 'BusyError';
		this.retryAfterMs = retryAfterMs;
	}
}

type Bucket = { tokens: number; updatedAt: number };

const IDLE_EVICTION_MS = 15 * 60_000;
const SWEEP_INTERVAL_OPS = 4_096;

export class RateLimiter {
	#buckets = new Map<string, Bucket>();
	#inFlight = new Map<string, number>();
	#queues = new Map<
		string,
		Array<{
			resolve: () => void;
			reject: (error: Error) => void;
			enqueuedAt: number;
			timer?: ReturnType<typeof setTimeout>;
		}>
	>();
	#daily = new Map<string, number>();
	#day: string;
	#db: () => Db;
	#queueWaitMs: number;
	#opsSinceSweep = 0;

	constructor(options: { db?: Db; queueWaitMs?: number; now?: () => number } = {}) {
		this.#db = () => options.db ?? getDb();
		this.#queueWaitMs = options.queueWaitMs ?? 5_000;
		this.#day = dayBucket();
	}

	/** Consume one request from the minute budget. */
	takeRequest(apiKeyId: string, limits: Limits, now: number = Date.now()): BudgetOutcome {
		this.#rollDay();
		this.#maybeSweep(now);
		const refillPerMs = Math.max(limits.rateLimitRpm, 1) / 60_000;
		const bucket = this.#buckets.get(apiKeyId) ?? { tokens: limits.rateLimitRpm, updatedAt: now };
		bucket.tokens = Math.min(
			limits.rateLimitRpm,
			bucket.tokens + (now - bucket.updatedAt) * refillPerMs
		);
		bucket.updatedAt = now;
		if (bucket.tokens < 1) {
			this.#buckets.set(apiKeyId, bucket);
			return {
				ok: false,
				remaining: Math.floor(bucket.tokens),
				retryAfterMs: Math.ceil((1 - bucket.tokens) / refillPerMs)
			};
		}
		bucket.tokens -= 1;
		this.#buckets.set(apiKeyId, bucket);
		return { ok: true, remaining: Math.floor(bucket.tokens) };
	}

	/** True when this key still has calls left today. */
	hasDailyQuota(apiKeyId: string, limits: Limits): boolean {
		if (limits.dailyCallQuota <= 0) return true;
		return this.#dailyFor(apiKeyId) < limits.dailyCallQuota;
	}

	/** Midnight UTC resets the counters; checked on access, not only on sweep. */
	#rollDay(): void {
		const today = dayBucket();
		if (today === this.#day) return;
		this.#day = today;
		this.#daily.clear();
	}

	/** Record one tool call against today's quota. */
	consumeDaily(apiKeyId: string, db: Db = this.#db()): void {
		const key = `${this.#day}:${apiKeyId}`;
		const next = this.#dailyFor(apiKeyId) + 1;
		this.#daily.set(key, next);
		// flush periodically: a restart should not hand out a fresh allowance
		if (next % 20 === 0) this.#persist(apiKeyId, next, db);
	}

	dailyUsed(apiKeyId: string): number {
		return this.#dailyFor(apiKeyId);
	}

	/**
	 * Take a concurrency slot. Resolves with a release function; rejects with
	 * `BusyError` when the queue wait budget runs out.
	 */
	async acquire(apiKeyId: string, limits: Limits): Promise<() => void> {
		const current = this.#inFlight.get(apiKeyId) ?? 0;
		if (current < Math.max(1, limits.maxConcurrency)) {
			this.#inFlight.set(apiKeyId, current + 1);
			return this.#releaser(apiKeyId);
		}
		await new Promise<void>((resolve, reject) => {
			const waiter: {
				resolve: () => void;
				reject: (error: Error) => void;
				enqueuedAt: number;
				timer?: ReturnType<typeof setTimeout>;
			} = {
				resolve: () => {
					clearTimeout(waiter.timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(waiter.timer);
					reject(error);
				},
				enqueuedAt: Date.now()
			};
			waiter.timer = setTimeout(() => {
				const queue = this.#queues.get(apiKeyId);
				if (queue) {
					const index = queue.indexOf(waiter);
					if (index >= 0) queue.splice(index, 1);
				}
				waiter.reject(
					new BusyError(
						`too many concurrent calls for this key (limit ${limits.maxConcurrency})`,
						0
					)
				);
			}, this.#queueWaitMs);
			const queue = this.#queues.get(apiKeyId) ?? [];
			queue.push(waiter);
			this.#queues.set(apiKeyId, queue);
		});
		this.#inFlight.set(apiKeyId, (this.#inFlight.get(apiKeyId) ?? 0) + 1);
		return this.#releaser(apiKeyId);
	}

	inFlight(apiKeyId: string): number {
		return this.#inFlight.get(apiKeyId) ?? 0;
	}

	/** Headers clients can back off with (FR-16 / acceptance). */
	static headers(outcome: { retryAfterMs?: number }, remaining: number): Record<string, string> {
		const headers: Record<string, string> = {
			'x-ratelimit-remaining': String(Math.max(0, remaining))
		};
		if (outcome.retryAfterMs !== undefined) {
			headers['retry-after'] = String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)));
		}
		return headers;
	}

	/** Forget state for a key (revocation, tests). */
	forget(apiKeyId: string): void {
		this.#buckets.delete(apiKeyId);
		this.#inFlight.delete(apiKeyId);
		this.#queues.delete(apiKeyId);
		for (const key of [...this.#daily.keys()])
			if (key.endsWith(`:${apiKeyId}`)) this.#daily.delete(key);
	}

	stats(): { buckets: number; daily: number; queued: number } {
		return {
			buckets: this.#buckets.size,
			daily: this.#daily.size,
			queued: [...this.#queues.values()].reduce((total, queue) => total + queue.length, 0)
		};
	}

	#releaser(apiKeyId: string): () => void {
		let released = false;
		return () => {
			if (released) return; // releasing twice would grant an extra slot
			released = true;
			const next = Math.max(0, (this.#inFlight.get(apiKeyId) ?? 1) - 1);
			this.#inFlight.set(apiKeyId, next);
			const waiter = this.#queues.get(apiKeyId)?.shift();
			if (waiter) waiter.resolve();
		};
	}

	#dailyFor(apiKeyId: string): number {
		this.#rollDay();
		const key = `${this.#day}:${apiKeyId}`;
		const cached = this.#daily.get(key);
		if (cached !== undefined) return cached;
		const restored = this.#restore(apiKeyId);
		this.#daily.set(key, restored);
		return restored;
	}

	#restore(apiKeyId: string): number {
		try {
			const row = this.#db()
				.select({ value: kv.value })
				.from(kv)
				.where(eq(kv.key, this.#quotaKey(apiKeyId)))
				.get();
			return row ? Number.parseInt(row.value, 10) || 0 : 0;
		} catch {
			return 0;
		}
	}

	#persist(apiKeyId: string, used: number, db: Db): void {
		try {
			const key = this.#quotaKey(apiKeyId);
			db.insert(kv)
				.values({ key, value: String(used) })
				.onConflictDoUpdate({ target: kv.key, set: { value: String(used) } })
				.run();
		} catch {
			// quota persistence is best effort; never fail a call over bookkeeping
		}
	}

	#quotaKey(apiKeyId: string): string {
		return `quota:${this.#day}:${apiKeyId}`;
	}

	/** Drop state for keys that have been quiet, so long-lived processes stay bounded. */
	#maybeSweep(now: number): void {
		this.#opsSinceSweep += 1;
		if (this.#opsSinceSweep < SWEEP_INTERVAL_OPS) return;
		this.#opsSinceSweep = 0;
		for (const [key, bucket] of [...this.#buckets.entries()]) {
			if (now - bucket.updatedAt > IDLE_EVICTION_MS) this.#buckets.delete(key);
		}
		for (const [key, count] of [...this.#inFlight.entries()]) {
			if (count === 0 && !this.#queues.has(key)) this.#inFlight.delete(key);
		}
	}
}

/** Process-wide limiter, wired into the auth boundary and the backend guard. */
export const rateLimiter = new RateLimiter();
