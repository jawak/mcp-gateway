/**
 * Upstream connection pool (T-08).
 *
 * Responsibilities, in order of importance:
 *  1. **One connection per upstream** — `get()` twice returns the same handle, so
 *     500 clients do not spawn 500 `npx` processes.
 *  2. **Bounded footprint** — at most `MCPGW_MAX_LIVE_UPSTREAMS` live connections.
 *     `pinned` upstreams stay warm (fast first call, health checks are cheap);
 *     `lazy` ones start on demand and are closed after `idleTtlMs`, with LRU
 *     eviction if the cap is reached. A 512 MB box must survive 50 configured
 *     upstreams even if only five are used.
 *  3. **Fairness** — a per-upstream semaphore keeps one slow server from
 *     monopolising the process, and a queue wait cap turns overload into a clean
 *     429-ish error rather than an unbounded pile-up.
 *  4. **Safe reuse** — closing waits for in-flight calls (BR-12), and shutdown
 *     guarantees no orphaned child processes.
 */
import type { UpstreamHandle, UpstreamRecord } from './types.ts';
import { UnconfiguredUpstreamError, UpstreamTransportError } from './types.ts';
import { connectStdio } from './stdio.ts';
import { connectRemoteHttp } from './remote-http.ts';
import { getConfig } from '../config.ts';
import { logger as rootLogger } from '../observability/logger.ts';
import { events } from '../registry/events.ts';

export type ConnectFn = (record: UpstreamRecord) => Promise<UpstreamHandle>;

export type PoolOptions = {
	/** Hard cap on simultaneous live connections. */
	maxLive?: number;
	/** Close idle `lazy` connections after this long. */
	idleTtlMs?: number;
	/** In-flight calls allowed per upstream before callers queue. */
	concurrencyPerUpstream?: number;
	/** How long a caller may wait for a slot before it is rejected. */
	queueWaitMs?: number;
	/** Grace given to in-flight calls when closing one upstream (BR-12). */
	closeGraceMs?: number;
	/** Injection point for tests. */
	connect?: ConnectFn;
	logger?: ReturnType<typeof rootLogger.child>;
};

type Entry = {
	slug: string;
	record: UpstreamRecord;
	handle: UpstreamHandle;
	lastUsedAt: number;
	/** Tie-breaker so LRU is deterministic when two touches land in the same ms. */
	lastUsedSeq: number;
	/** Slots currently handed out; guarded by `queue`. */
	inFlight: number;
	queue: Array<{ resolve: () => void; reject: (error: Error) => void; enqueuedAt: number }>;
	released: boolean;
};

export type PoolStats = {
	live: number;
	maxLive: number;
	pinned: number;
	lazy: number;
	bySlug: Record<
		string,
		{ transport: string; inFlight: number; idleMs: number; connected: boolean }
	>;
};

/** Default factory: pick the transport from the record. */
export const defaultConnect: ConnectFn = (record) =>
	record.transport === 'stdio' ? connectStdio({ record }) : connectRemoteHttp({ record });

export class UpstreamPool {
	#entries = new Map<string, Entry>();
	#maxLive: number;
	#idleTtlMs: number;
	#concurrency: number;
	#queueWaitMs: number;
	#closeGraceMs: number;
	#connect: ConnectFn;
	#log;
	#sweeper: ReturnType<typeof setInterval> | undefined;
	#shuttingDown = false;
	#connecting = new Map<string, Promise<UpstreamHandle>>();
	#seq = 0;

	constructor(options: PoolOptions = {}) {
		const config = getConfig();
		this.#maxLive = options.maxLive ?? config.maxLiveUpstreams;
		this.#idleTtlMs = options.idleTtlMs ?? 10 * 60_000;
		this.#concurrency = Math.max(1, options.concurrencyPerUpstream ?? 10);
		this.#queueWaitMs = options.queueWaitMs ?? 15_000;
		this.#closeGraceMs = options.closeGraceMs ?? config.gracefulShutdownMs;
		this.#connect = options.connect ?? defaultConnect;
		this.#log = (options.logger ?? rootLogger).child({ component: 'upstream-pool' });
	}

	get size(): number {
		return this.#entries.size;
	}

	/** Warm the pinned upstreams at boot; failures are recorded, never fatal. */
	async warm(
		records: UpstreamRecord[]
	): Promise<{ warmed: string[]; failed: Array<{ slug: string; error: string }> }> {
		const warmed: string[] = [];
		const failed: Array<{ slug: string; error: string }> = [];
		for (const record of records.filter((entry) => entry.enabled && entry.pin === 'pinned')) {
			try {
				await this.get(record);
				warmed.push(record.slug);
			} catch (error) {
				failed.push({ slug: record.slug, error: (error as Error).message });
			}
		}
		this.#log.info({ warmed: warmed.length, failed: failed.length }, 'warm-up finished');
		return { warmed, failed };
	}

	/** Reuse the handle for this upstream, connecting it if necessary. */
	async get(record: UpstreamRecord): Promise<UpstreamHandle> {
		if (this.#shuttingDown)
			throw new UpstreamTransportError(record.slug, 'gateway is shutting down', false);
		if (!record.enabled)
			throw new UpstreamTransportError(record.slug, 'upstream is disabled', false);

		const existing = this.#entries.get(record.slug);
		if (existing && !existing.released) {
			this.#touch(existing);
			// config may have changed since connect → drop and reconnect
			if (!sameConnection(existing.record, record)) {
				this.#log.info({ slug: record.slug }, 'upstream config changed, reconnecting');
				await this.#release(existing, 'manual');
				return this.#connectAndTrack(record);
			}
			await existing.handle.ensureAlive();
			return existing.handle;
		}

		const pending = this.#connecting.get(record.slug);
		if (pending) return pending;

		const promise = this.#connectAndTrack(record);
		this.#connecting.set(record.slug, promise);
		try {
			return await promise;
		} finally {
			this.#connecting.delete(record.slug);
		}
	}

	async #connectAndTrack(record: UpstreamRecord): Promise<UpstreamHandle> {
		await this.#makeRoom(record);
		const handle = await this.#connect(record);
		const entry: Entry = {
			slug: record.slug,
			record,
			handle,
			lastUsedAt: Date.now(),
			lastUsedSeq: ++this.#seq,
			inFlight: 0,
			queue: [],
			released: false
		};
		this.#entries.set(record.slug, entry);
		this.#log.info(
			{ slug: record.slug, live: this.#entries.size, maxLive: this.#maxLive },
			'upstream pooled'
		);
		events.emit('pool.connected', { slug: record.slug, transport: record.transport });
		return handle;
	}

	/** Free capacity before connecting: close the least-recently-used lazy entries. */
	#touch(entry: Entry): void {
		entry.lastUsedAt = Date.now();
		entry.lastUsedSeq = ++this.#seq;
	}

	async #makeRoom(record: UpstreamRecord): Promise<void> {
		if (this.#entries.size < this.#maxLive) return;
		const evictable = [...this.#entries.values()]
			.filter(
				(entry) =>
					!entry.released && entry.record.pin === 'lazy' && entry.record.slug !== record.slug
			)
			.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.lastUsedSeq - b.lastUsedSeq);
		for (const candidate of evictable) {
			if (this.#entries.size < this.#maxLive) return;
			this.#log.warn(
				{ slug: candidate.slug, reason: 'pool at capacity' },
				'evicting idle upstream'
			);
			await this.#release(candidate, 'evicted');
		}
		if (this.#entries.size >= this.#maxLive) {
			// everything live is pinned: allow one over the cap rather than refusing
			// service, and say so once per connect
			this.#log.warn(
				{ live: this.#entries.size, maxLive: this.#maxLive },
				'all live upstreams are pinned; exceeding the cap for this connection'
			);
		}
	}

	/**
	 * Run `fn` with a concurrency slot for this upstream. Slots are fair
	 * (FIFO) and waiting longer than `queueWaitMs` is refused so a hung upstream
	 * cannot accumulate unbounded waiters.
	 */
	async withHandle<T>(
		record: UpstreamRecord,
		fn: (handle: UpstreamHandle) => Promise<T>
	): Promise<T> {
		const handle = await this.get(record);
		const entry = this.#entries.get(record.slug);
		if (!entry)
			throw new UpstreamTransportError(record.slug, 'connection was closed concurrently', true);

		await this.#acquire(entry);
		try {
			return await fn(handle);
		} finally {
			this.#releaseSlot(entry);
		}
	}

	async #acquire(entry: Entry): Promise<void> {
		if (entry.inFlight < this.#concurrency) {
			entry.inFlight += 1;
			return;
		}
		const queued = new Promise<void>((resolve, reject) => {
			const waiter = {
				resolve: () => {
					entry.inFlight += 1;
					resolve();
				},
				reject: (error: Error) => reject(error),
				enqueuedAt: Date.now()
			};
			entry.queue.push(waiter);
			setTimeout(() => {
				const index = entry.queue.indexOf(waiter);
				if (index >= 0) {
					entry.queue.splice(index, 1);
					waiter.reject(
						new UpstreamTransportError(
							entry.slug,
							`upstream busy (${entry.inFlight}/${this.#concurrency} slots in use, waited ${this.#queueWaitMs}ms)`,
							true
						)
					);
				}
			}, this.#queueWaitMs);
		});
		// A queue rejection is expected whenever an upstream closes; mark the promise
		// handled so it never surfaces as an unhandled rejection before the caller
		// awaits it (the caller still sees the error).
		queued.catch(() => undefined);
		await queued;
	}

	#releaseSlot(entry: Entry): void {
		entry.inFlight -= 1;
		this.#touch(entry);
		if (entry.released) {
			// the upstream was closed while callers waited — never hand them a dead slot
			for (const waiter of entry.queue.splice(0)) {
				waiter.reject(
					new UpstreamTransportError(entry.slug, 'upstream connection was closed', true)
				);
			}
			return;
		}
		const next = entry.queue.shift();
		if (next) next.resolve();
	}

	/** Close one upstream (used by the admin UI and config changes). */
	async close(
		slug: string,
		options: { graceMs?: number; reason?: 'manual' | 'idle' | 'evicted' | 'shutdown' } = {}
	): Promise<boolean> {
		const entry = this.#entries.get(slug);
		if (!entry) return false;
		await this.#release(entry, options.reason ?? 'manual', options.graceMs ?? this.#closeGraceMs);
		return true;
	}

	async #release(
		entry: Entry,
		reason: 'idle' | 'manual' | 'evicted' | 'shutdown',
		graceMs?: number
	): Promise<void> {
		if (entry.released) return;
		entry.released = true;
		this.#entries.delete(entry.slug);
		// queued callers can never be served on a closed connection
		for (const waiter of entry.queue.splice(0)) {
			waiter.reject(new UpstreamTransportError(entry.slug, 'upstream connection was closed', true));
		}
		try {
			await entry.handle.close({ graceMs: graceMs ?? this.#closeGraceMs });
		} catch (error) {
			this.#log.warn({ slug: entry.slug, err: error }, 'error while closing upstream');
		}
		this.#log.info({ slug: entry.slug, reason, live: this.#entries.size }, 'upstream released');
		events.emit('pool.closed', { slug: entry.slug, reason });
	}

	/** Close idle `lazy` connections. Called by the worker on its own interval. */
	async sweepIdle(now: number = Date.now()): Promise<string[]> {
		const closed: string[] = [];
		for (const entry of [...this.#entries.values()]) {
			if (entry.record.pin !== 'lazy' || entry.inFlight > 0 || entry.queue.length > 0) continue;
			if (now - entry.lastUsedAt < this.#idleTtlMs) continue;
			await this.#release(entry, 'idle');
			closed.push(entry.slug);
		}
		if (closed.length > 0) this.#log.info({ closed }, 'closed idle lazy upstreams');
		return closed;
	}

	/** Start the idle sweeper (the worker process owns this in production). */
	startIdleSweeper(intervalMs = 60_000): void {
		if (this.#sweeper) return;
		this.#sweeper = setInterval(
			() =>
				void this.sweepIdle().catch((error: unknown) =>
					this.#log.error({ err: error }, 'idle sweep failed')
				),
			intervalMs
		);
		this.#sweeper.unref?.();
	}

	stopIdleSweeper(): void {
		if (this.#sweeper) clearInterval(this.#sweeper);
		this.#sweeper = undefined;
	}

	/** Shutdown: no orphaned child processes may survive this. */
	async closeAll(graceMs = this.#closeGraceMs): Promise<void> {
		this.#shuttingDown = true;
		this.stopIdleSweeper();
		const entries = [...this.#entries.values()];
		await Promise.all(entries.map((entry) => this.#release(entry, 'shutdown', graceMs)));
		this.#log.info({ closed: entries.length }, 'pool closed');
	}

	stats(): PoolStats {
		const bySlug: PoolStats['bySlug'] = {};
		for (const entry of this.#entries.values()) {
			bySlug[entry.slug] = {
				transport: entry.record.transport,
				inFlight: entry.inFlight,
				idleMs: Date.now() - entry.lastUsedAt,
				connected: entry.handle.connected
			};
		}
		return {
			live: this.#entries.size,
			maxLive: this.#maxLive,
			pinned: [...this.#entries.values()].filter((entry) => entry.record.pin === 'pinned').length,
			lazy: [...this.#entries.values()].filter((entry) => entry.record.pin === 'lazy').length,
			bySlug
		};
	}

	/** Live handle without connecting — for status pages and health probes. */
	peek(slug: string): UpstreamHandle | undefined {
		const entry = this.#entries.get(slug);
		return entry && !entry.released ? entry.handle : undefined;
	}

	liveSlugs(): string[] {
		return [...this.#entries.keys()];
	}
}

/** Compare the parts of a record that require a reconnect when changed. */
function sameConnection(a: UpstreamRecord, b: UpstreamRecord): boolean {
	return (
		a.transport === b.transport &&
		a.timeoutMs === b.timeoutMs &&
		JSON.stringify(a.connection) === JSON.stringify(b.connection) &&
		JSON.stringify(a.envRefs) === JSON.stringify(b.envRefs) &&
		a.headersRef === b.headersRef
	);
}

export { UnconfiguredUpstreamError };

/**
 * Lazily created process-wide pool.
 *
 * Deliberately not a module-level `new UpstreamPool()`: the constructor reads
 * config, and an eager instance made every importer of this module (migrations,
 * backup scripts, tests) require a fully valid environment before it could even
 * load.
 */
let sharedPool: UpstreamPool | undefined;

export function getUpstreamPool(): UpstreamPool {
	sharedPool ??= new UpstreamPool();
	return sharedPool;
}
