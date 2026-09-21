/**
 * Health monitor tests (T-09).
 *
 * The probe is injected so state transitions, backoff and catalog effects are
 * tested deterministically, without spawning anything.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
	HealthMonitor,
	createPoolProbe,
	loadUpstreamRecords,
	pruneHealthRows,
	toUpstreamRecord
} from '../../src/lib/server/upstream/health';
import type { ProbeOutcome } from '../../src/lib/server/upstream/health';
import type { UpstreamRecord } from '../../src/lib/server/upstream/types';
import { UpstreamPool } from '../../src/lib/server/upstream/pool';
import { getDb, useDatabaseForTests, getSqlite } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { upstreamHealth, upstreams } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import { status } from '../../src/lib/server/observability/status';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-health-'));
const pool = new UpstreamPool({
	connect: async () => {
		throw new Error('not used');
	}
});

function row(slug: string, overrides: Partial<UpstreamRecord> = {}): UpstreamRecord {
	return {
		id: uuidv7(),
		slug,
		name: slug,
		transport: 'stdio',
		enabled: true,
		connection: { command: 'true' },
		envRefs: {},
		timeoutMs: 10_000,
		pin: 'pinned',
		...overrides
	};
}

/** Scripted probe: replays the given outcomes, then repeats the last one. */
function scripted(...outcomes: ProbeOutcome[]) {
	let index = 0;
	const calls: string[] = [];
	return {
		calls,
		probe: async (record: UpstreamRecord): Promise<ProbeOutcome> => {
			calls.push(record.slug);
			return outcomes[Math.min(index++, outcomes.length - 1)];
		}
	};
}

function monitorFor(
	records: UpstreamRecord[],
	probe: ReturnType<typeof scripted>['probe'],
	opts = {}
) {
	return new HealthMonitor(pool, { listRecords: () => records, probe, db: getDb(), ...opts });
}

/** Persist the upstream row so `upstream_health`'s foreign key is satisfied. */
function persist(record: UpstreamRecord): UpstreamRecord {
	getDb()
		.insert(upstreams)
		.values({
			id: record.id,
			slug: record.slug,
			name: record.name,
			transport: record.transport,
			enabled: record.enabled,
			connection: record.connection as Record<string, unknown>,
			envRefs: record.envRefs,
			timeoutMs: record.timeoutMs,
			pin: record.pin
		})
		.onConflictDoNothing()
		.run();
	return record;
}

function healthRowsFor(id: string) {
	return getDb()
		.select()
		.from(upstreamHealth)
		.all()
		.filter((entry) => entry.upstreamId === id);
}

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = 'f'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

describe('health transitions', () => {
	test('3 consecutive failures mark an upstream down, 2 successes recover it', async () => {
		const record = persist(row('flaky'));
		const failure: ProbeOutcome = { ok: false, error: 'ECONNREFUSED' };
		const success: ProbeOutcome = { ok: true, latencyMs: 12 };
		const monitor = monitorFor(
			[record],
			scripted(failure, failure, failure, success, success).probe
		);

		expect(await monitor.check(record)).toBe('healthy'); // 1st failure
		expect(await monitor.check(record)).toBe('healthy'); // 2nd failure
		expect(await monitor.check(record)).toBe('down'); // 3rd failure
		// a `down` upstream is only re-probed once its backoff elapses, so recovery is
		// checked with force (what the admin "check now" button does)
		expect(await monitor.check(record, { force: true })).toBe('down'); // 1st success: not enough
		expect(await monitor.check(record, { force: true })).toBe('healthy'); // 2nd success
	});

	test('a slow-but-healthy probe is reported as degraded', async () => {
		const record = persist(row('slow', { timeoutMs: 4_000 }));
		const monitor = monitorFor([record], scripted({ ok: true, latencyMs: 2_500 }).probe);
		expect(await monitor.check(record)).toBe('degraded'); // > 50% of 4s
	});

	test('a `down` upstream is not probed again until its backoff elapses', async () => {
		const record = persist(row('cooling'));
		const scriptedProbe = scripted({ ok: false, error: 'boom' });
		const monitor = monitorFor([record], scriptedProbe.probe);
		await monitor.check(record);
		await monitor.check(record);
		await monitor.check(record); // down
		const callsBefore = scriptedProbe.calls.length;
		await monitor.check(record); // in backoff → no probe
		expect(scriptedProbe.calls.length).toBe(callsBefore);
		expect(monitor.stateOf('cooling')).toBe('down');
	});

	test('`force` ignores the backoff window (admin "check now")', async () => {
		const record = persist(row('forced'));
		const scriptedProbe = scripted({ ok: false, error: 'boom' });
		const monitor = monitorFor([record], scriptedProbe.probe);
		await monitor.check(record);
		await monitor.check(record);
		await monitor.check(record);
		const before = scriptedProbe.calls.length;
		await monitor.check(record, { force: true });
		expect(scriptedProbe.calls.length).toBe(before + 1);
	});

	test('a disabled upstream is down without probing', async () => {
		const record = persist(row('disabled', { enabled: false }));
		const scriptedProbe = scripted({ ok: true, latencyMs: 1 });
		const monitor = monitorFor([record], scriptedProbe.probe);
		expect(await monitor.check(record)).toBe('down');
		expect(scriptedProbe.calls).toEqual([]);
	});

	test('cold lazy upstreams are skipped, not spawned', async () => {
		const record = persist(row('lazy-one', { pin: 'lazy' }));
		const scriptedProbe = scripted({ ok: true, latencyMs: 5 });
		const monitor = monitorFor([record], scriptedProbe.probe);
		expect(await monitor.check(record)).toBe('healthy');
		expect(scriptedProbe.calls).toEqual([]);

		const eager = monitorFor([record], scriptedProbe.probe, { probeLazyCold: true });
		await eager.check(record);
		expect(scriptedProbe.calls).toEqual(['lazy-one']);
	});

	test('a missing env reference becomes `unconfigured` and names the variable', async () => {
		const record = persist(row('unconf'));
		const monitor = monitorFor([record], async () => ({
			ok: false,
			unconfigured: true,
			error: 'env SENTRY_TOKEN is not set on the gateway host'
		}));
		expect(await monitor.check(record)).toBe('unconfigured');
		const rows = healthRowsFor(record.id);
		expect(rows.at(-1)?.status).toBe('unconfigured');
		expect(rows.at(-1)?.error).toContain('SENTRY_TOKEN');
	});

	test('errors are redacted before they reach the database', async () => {
		const record = persist(row('leaky'));
		const monitor = monitorFor([record], async () => ({
			ok: false,
			error: 'auth failed with token ghp_SecretValue000000000'
		}));
		await monitor.check(record);
		const [rowEntry] = healthRowsFor(record.id);
		expect(rowEntry.error).toContain('[redacted]');
		expect(rowEntry.error).not.toContain('ghp_SecretValue000000000');
	});
});

describe('sweepAll', () => {
	test('probes every enabled upstream, reports changes and refreshes counters', async () => {
		const healthy = persist(row('sweep-healthy'));
		const failing = persist(row('sweep-failing'));
		const lazy = persist(row('sweep-lazy', { pin: 'lazy' }));
		const calls: string[] = [];
		const monitor = new HealthMonitor(pool, {
			listRecords: () => [healthy, failing, lazy],
			probe: async (record) => {
				calls.push(record.slug);
				return record.slug === 'sweep-failing'
					? { ok: false, error: 'nope' }
					: { ok: true, latencyMs: 5 };
			},
			db: getDb()
		});
		const result = await monitor.sweepAll();
		expect(calls.sort()).toEqual(['sweep-failing', 'sweep-healthy']);
		expect(result.states).toMatchObject({ 'sweep-healthy': 'healthy', 'sweep-failing': 'healthy' });
		// all three still read healthy: one failure is not enough to trip, and the
		// cold lazy upstream keeps its default state
		expect(status.upstreamsHealthy).toBe(3);
		expect(status.upstreamsUnconfigured).toBe(0);
		expect(status.liveUpstreams).toBe(3);

		// after 3 sweeps the failing one is down and the counters follow
		await monitor.sweepAll();
		await monitor.sweepAll();
		expect(monitor.stateOf('sweep-failing')).toBe('down');
		expect(status.upstreamsDown).toBe(1);
	});

	test('trackers of deleted upstreams are dropped', async () => {
		const gone = persist(row('gone'));
		const monitor = monitorFor([gone], scripted({ ok: true, latencyMs: 1 }).probe);
		await monitor.check(gone);
		expect(Object.keys(monitor.states())).toContain('gone');
		const empty = new HealthMonitor(pool, {
			listRecords: () => [],
			probe: async () => ({ ok: true }),
			db: getDb()
		});
		await empty.check(gone);
		await empty.sweepAll();
		expect(empty.states()).toEqual({});
	});
});

describe('persistence and helpers', () => {
	test('health rows are written with the upstream id and readable via the timeline helper', async () => {
		const id = uuidv7();
		const slug = `db-${id.slice(-6)}`;
		void slug;
		getDb()
			.insert(upstreams)
			.values({ id, slug, name: slug, transport: 'stdio', connection: { command: 'true' } })
			.run();
		const stored = getDb()
			.select()
			.from(upstreams)
			.all()
			.find((entry) => entry.id === id);
		expect(stored).toBeDefined();
		const record = toUpstreamRecord(stored!);
		const monitor = monitorFor([record], scripted({ ok: true, latencyMs: 12 }).probe);
		await monitor.check(record);

		const rows = healthRowsFor(id);
		expect(rows.length).toBe(1);
		expect(rows[0].status).toBe('healthy');
		expect(rows[0].latencyMs).toBe(12);
	});

	test('pruneHealthRows removes only expired rows', async () => {
		const id = persist(row(`prune-${uuidv7().slice(-6)}`)).id;
		const insert = (checkedAt: string) =>
			getDb()
				.insert(upstreamHealth)
				.values({ id: uuidv7(), upstreamId: id, status: 'healthy', ok: true, checkedAt })
				.run();
		insert('2020-01-01T00:00:00.000Z');
		insert(new Date().toISOString());
		const removed = pruneHealthRows(30, getDb());
		expect(removed).toBeGreaterThanOrEqual(1);
		const remaining = healthRowsFor(id);
		expect(
			remaining.every((entry) => entry.checkedAt.startsWith(String(new Date().getFullYear())))
		).toBe(true);
	});

	test('loadUpstreamRecords reads runtime records from the database', () => {
		const id = uuidv7();
		const slug = `rec-${id.slice(-6)}`;
		getDb()
			.insert(upstreams)
			.values({
				id,
				slug,
				name: slug,
				transport: 'http',
				connection: { url: 'https://x.example/mcp' },
				pin: 'lazy'
			})
			.run();
		const loaded = loadUpstreamRecords(getDb()).find((entry) => entry.slug === slug);
		expect(loaded).toMatchObject({ slug, transport: 'http', pin: 'lazy' });
	});

	test('createPoolProbe uses the pooled handle and never spawns for peek misses', async () => {
		let connects = 0;
		const probePool = new UpstreamPool({
			connect: async () => {
				connects += 1;
				throw new Error('connect refused');
			}
		});
		const probe = createPoolProbe(probePool);
		const outcome = await probe(row('cold'), 2_000);
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain('connect refused');
		expect(connects).toBe(1);
		await probePool.closeAll(0);
	});

	test('the sqlite handle stays usable after all of the above', () => {
		const row = getSqlite().prepare('select 1 as ok').get() as { ok: number };
		expect(row.ok).toBe(1);
		rmSync(dir, { recursive: true, force: true });
	});
});
