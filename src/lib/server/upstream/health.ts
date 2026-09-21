/**
 * Upstream health monitoring (T-09).
 *
 * Runs in the worker process so a slow or hung upstream can never delay a real
 * request. Rules implemented from the PRD:
 *
 *   - probe = `ping` when the upstream declares it, otherwise `tools/list`
 *   - 3 consecutive failures → `down` (and out of the catalog); 2 consecutive
 *     successes → `healthy` again
 *   - a `down` upstream is probed with exponential backoff, capped at 5 minutes,
 *     so 50 dead upstreams do not generate 50 requests every 30 seconds
 *   - an upstream whose required env/secret is missing is `unconfigured`: it is
 *     never spawned and the reason names the variable
 *   - `lazy` upstreams with no live connection are not probed — that would spawn
 *     a process just to answer a health question
 *
 * Every probe is written to `upstream_health` (timeline in the UI, retention
 * handled by the GC job) and aggregated into `observability/status` for /healthz.
 */
import { count, desc, lte } from 'drizzle-orm';
import { FailureTracker, type HealthState } from './restart.ts';
import type { UpstreamPool } from './pool.ts';
import type { UpstreamRecord } from './types.ts';
import { UnconfiguredUpstreamError } from './types.ts';
import { getDb, type Db } from '../db/index.ts';
import { upstreamHealth, upstreams } from '../db/schema.ts';
import { uuidv7 } from '../../shared/ids.ts';
import { nowIso } from '../../shared/time.ts';
import { getConfig } from '../config.ts';
import { status } from '../observability/status.ts';
import { events } from '../registry/events.ts';
import { redactString } from '../security/redact.ts';
import { logger as rootLogger } from '../observability/logger.ts';

export type ProbeOutcome = {
	ok: boolean;
	latencyMs?: number;
	error?: string;
	unconfigured?: boolean;
};
export type ProbeFn = (record: UpstreamRecord, timeoutMs: number) => Promise<ProbeOutcome>;

export type HealthOptions = {
	/** Where to read the current upstream list from. */
	listRecords?: () => Promise<UpstreamRecord[]> | UpstreamRecord[];
	/** Probe implementation; defaults to ping/tools/list through the pool. */
	probe?: ProbeFn;
	/** A `lazy` upstream without a live connection is skipped unless true. */
	probeLazyCold?: boolean;
	db?: Db;
	logger?: ReturnType<typeof rootLogger.child>;
	now?: () => number;
};

export type SweepResult = {
	checked: number;
	skipped: number;
	changed: Array<{ slug: string; from: HealthState; to: HealthState }>;
	states: Record<string, HealthState>;
};

/**
 * Default probe: use the pooled connection when there is one (so probing never
 * spawns anything), otherwise a cold connection for pinned upstreams only.
 */
export function createPoolProbe(pool: UpstreamPool): ProbeFn {
	return async (record, timeoutMs) => {
		try {
			const handle = pool.peek(record.slug) ?? (await pool.get(record));
			const capabilities = handle.diagnostics().capabilities ?? {};
			if (capabilities.ping !== undefined) {
				const { latencyMs } = await handle.ping(Math.min(timeoutMs, 5_000));
				return { ok: true, latencyMs };
			}
			const started = Date.now();
			await handle.listTools({ timeoutMs: Math.min(timeoutMs, 5_000) });
			return { ok: true, latencyMs: Date.now() - started };
		} catch (error) {
			if (error instanceof UnconfiguredUpstreamError) {
				return { ok: false, unconfigured: true, error: error.missing };
			}
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: redactString(message) };
		}
	};
}

export class HealthMonitor {
	#trackers = new Map<string, FailureTracker>();
	#listRecords: NonNullable<HealthOptions['listRecords']>;
	#probe: ProbeFn;
	#probeLazyCold: boolean;
	#db: Db;
	#log;
	#now: () => number;
	#defaultProbeMs: number;

	constructor(pool: UpstreamPool, options: HealthOptions = {}) {
		this.#listRecords =
			options.listRecords ?? (async () => loadUpstreamRecords(options.db ?? getDb()));
		const probe = options.probe ?? createPoolProbe(pool);
		if (typeof probe !== 'function') {
			throw new TypeError(
				'HealthMonitor: options.probe must be a function (did you pass a scripted helper object?)'
			);
		}
		this.#probe = probe;
		this.#probeLazyCold = options.probeLazyCold ?? false;
		this.#db = options.db ?? getDb();
		this.#log = (options.logger ?? rootLogger).child({ component: 'health' });
		this.#now = options.now ?? (() => Date.now());
		this.#defaultProbeMs = getConfig().upstreamTimeoutMs;
	}

	/** Current state for one upstream (used by the catalog and the UI). */
	stateOf(slug: string, fallback: HealthState = 'healthy'): HealthState {
		return this.#trackers.get(slug)?.state ?? fallback;
	}

	states(): Record<string, HealthState> {
		return Object.fromEntries(
			[...this.#trackers.entries()].map(([slug, tracker]) => [slug, tracker.state])
		);
	}

	/** Forget history for one upstream (config changed, admin hit "check now"). */
	forget(slug: string, state: HealthState = 'healthy'): void {
		this.#trackers.get(slug)?.reset(state);
		if (!this.#trackers.has(slug)) this.#trackers.set(slug, new FailureTracker({ state }));
	}

	/** Probe one upstream and apply the transition rules. */
	async check(record: UpstreamRecord, options: { force?: boolean } = {}): Promise<HealthState> {
		const tracker = this.#trackerFor(record.slug);

		if (!record.enabled) {
			const previous = tracker.state;
			tracker.reset('down');
			if (previous !== 'down') {
				this.#record(record, 'down', { ok: false, error: 'upstream disabled' });
				events.emit('health.changed', { slug: record.slug, status: 'down', previous });
			}
			return 'down';
		}
		if (record.pin === 'lazy' && this.#probeLazyCold === false) {
			// nothing live: answering "is it up?" must not cost a process spawn
			return tracker.state;
		}
		// Backoff only throttles upstreams that are already down: a flapping one must
		// be able to trip to `down` within its normal interval (PRD: probe interval of
		// a *down* upstream doubles, capped at 5 minutes).
		if (!options.force && tracker.state === 'down' && !tracker.due) {
			return tracker.state;
		}

		const timeoutMs = Math.min(record.timeoutMs, this.#defaultProbeMs);
		const outcome = await this.#probe(record, timeoutMs);

		if (outcome.unconfigured) {
			tracker.reset('unconfigured');
			this.#record(record, 'unconfigured', { error: outcome.error });
			this.#log.warn({ slug: record.slug, reason: outcome.error }, 'upstream is not configured');
			return 'unconfigured';
		}

		const transition = tracker.record({
			ok: outcome.ok,
			latencyMs: outcome.latencyMs,
			degradedAboveMs: Math.floor(record.timeoutMs / 2)
		});

		this.#record(record, transition.state, {
			latencyMs: outcome.latencyMs,
			ok: outcome.ok,
			error: outcome.error
		});

		if (transition.changed) {
			this.#log[transition.state === 'down' ? 'error' : 'info'](
				{ slug: record.slug, from: transition.previous, to: transition.state },
				'upstream health changed'
			);
			events.emit('health.changed', {
				slug: record.slug,
				status: transition.state,
				previous: transition.previous
			});
		}
		return transition.state;
	}

	/** Probe everything that is due. Called on the worker's interval. */
	async sweepAll(options: { force?: boolean } = {}): Promise<SweepResult> {
		const records = await this.#listRecords();
		const started = this.#now();
		let skipped = 0;
		void started; // kept for future duration metric
		const changed: SweepResult['changed'] = [];

		for (const record of records) {
			const before = this.stateOf(record.slug);
			const after = await this.check(record, options);
			if (after !== before) changed.push({ slug: record.slug, from: before, to: after });
			const tracker = this.#trackerFor(record.slug);
			if (record.pin === 'lazy' && !this.#probeLazyCold) skipped += 1;
			else if (!options.force && !tracker.due && before === after) skipped += 1;
		}

		// prune trackers for upstreams that were deleted
		const live = new Set(records.map((record) => record.slug));
		for (const slug of [...this.#trackers.keys()]) if (!live.has(slug)) this.#trackers.delete(slug);

		this.recountStatuses(records);
		status.lastHealthSweepAt = new Date();
		return { checked: records.length - skipped, skipped, changed, states: this.states() };
	}

	/** Recompute the aggregate counters exposed by /healthz. */
	recountStatuses(records: UpstreamRecord[]): void {
		const states = records.map((record) =>
			this.stateOf(record.slug, record.enabled ? 'healthy' : 'down')
		);
		status.upstreamsHealthy = states.filter((state) => state === 'healthy').length;
		status.upstreamsDegraded = states.filter((state) => state === 'degraded').length;
		status.upstreamsDown = states.filter((state) => state === 'down').length;
		status.upstreamsUnconfigured = states.filter((state) => state === 'unconfigured').length;
		status.liveUpstreams = records.filter((record) => record.enabled).length;
	}

	#trackerFor(slug: string): FailureTracker {
		let tracker = this.#trackers.get(slug);
		if (!tracker) {
			tracker = new FailureTracker();
			this.#trackers.set(slug, tracker);
		}
		return tracker;
	}

	#record(
		record: UpstreamRecord,
		state: HealthState,
		result: { latencyMs?: number; ok?: boolean; error?: string }
	): void {
		try {
			this.#db
				.insert(upstreamHealth)
				.values({
					id: uuidv7(),
					upstreamId: record.id,
					status: state,
					latencyMs: result.latencyMs,
					ok: (result.ok ?? state === 'healthy') || state === 'degraded',
					error: result.error ? redactString(result.error).slice(0, 500) : null,
					checkedAt: nowIso()
				})
				.run();
		} catch (error) {
			// an upstream id that no longer exists must not break the sweep
			this.#log.debug({ slug: record.slug, err: error }, 'health row not written');
		}
	}
}

/** Row → runtime record projection used by the health sweep and the pool. */
export function toUpstreamRecord(row: typeof upstreams.$inferSelect): UpstreamRecord {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		transport: row.transport,
		enabled: row.enabled,
		connection: row.connection as UpstreamRecord['connection'],
		envRefs: row.envRefs ?? {},
		headersRef: row.headersRef,
		timeoutMs: row.timeoutMs,
		pin: row.pin,
		caps: row.caps ?? null,
		toolsCount: row.toolsCount,
		lastError: row.lastError,
		status: (row.status as { state?: string } | null) ?? null
	};
}

export function loadUpstreamRecords(db: Db = getDb()): UpstreamRecord[] {
	return db.select().from(upstreams).all().map(toUpstreamRecord);
}

/** Most recent status per upstream, for the dashboard list. */
export function latestHealthByUpstream(
	db: Db = getDb()
): Map<
	string,
	{ status: HealthState; latencyMs: number | null; error: string | null; checkedAt: string }
> {
	const rows = db
		.select({
			upstreamId: upstreamHealth.upstreamId,
			status: upstreamHealth.status,
			latencyMs: upstreamHealth.latencyMs,
			error: upstreamHealth.error,
			checkedAt: upstreamHealth.checkedAt
		})
		.from(upstreamHealth)
		// UUIDv7 ids break ties inside the same millisecond, so "latest" stays
		// well-defined even when two probes land in one tick
		.orderBy(desc(upstreamHealth.checkedAt), desc(upstreamHealth.id))
		.all();
	const latest = new Map<
		string,
		{ status: HealthState; latencyMs: number | null; error: string | null; checkedAt: string }
	>();
	for (const row of rows) if (!latest.has(row.upstreamId)) latest.set(row.upstreamId, row);
	return latest;
}

/** Retention: called by the GC job (T-46). Returns how many rows were removed. */
export function pruneHealthRows(days: number, db: Db = getDb()): number {
	const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
	const [{ value: stale }] = db
		.select({ value: count() })
		.from(upstreamHealth)
		.where(lte(upstreamHealth.checkedAt, cutoff))
		.all();
	db.delete(upstreamHealth).where(lte(upstreamHealth.checkedAt, cutoff)).run();
	return stale;
}
