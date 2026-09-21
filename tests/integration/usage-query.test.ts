/**
 * Log/usage queries and CSV export (T-36, T-37, T-26 rollup).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	asCallStatus,
	callsToCsv,
	hourlySeries,
	overview,
	rollupHourly,
	topTools,
	usageByKey,
	queryCallLog
} from '../../src/lib/server/observability/usage-query';
import { recordCall } from '../../src/lib/server/observability/usage';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { apiKeys, profiles, upstreams, usageHourly } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';

const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-usage-'));
let keyId = '';
let upstreamId = '';

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '5'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));

	const db = getDb();
	const profileId = uuidv7();
	upstreamId = uuidv7();
	keyId = uuidv7();
	db.insert(profiles).values({ id: profileId, name: 'usage-profile' }).run();
	db.insert(upstreams)
		.values({
			id: upstreamId,
			slug: 'usage-host',
			name: 'Usage host',
			transport: 'stdio',
			connection: { command: 'true' }
		})
		.run();
	db.insert(apiKeys)
		.values({
			id: keyId,
			keyHash: uuidv7(),
			keyPrefix: 'mcpgw_us',
			keyTail4: '1111',
			name: 'laptop',
			profileId
		})
		.run();

	// realistic spread: successes, an error, a timeout, and something outside the window
	const now = Date.now();
	const record = (tool: string, status: string, minutesAgo: number, durationMs: number) =>
		recordCall({
			requestId: `req-${minutesAgo}-${tool}`,
			apiKeyId: keyId,
			upstreamId,
			tool,
			upstreamTool: tool.split('__')[1] ?? tool,
			status: status as 'ok',
			durationMs,
			reqBytes: 40,
			resBytes: 200,
			error: status === 'ok' ? null : `boom for ${tool}`,
			calledAt: new Date(now - minutesAgo * 60_000).toISOString()
		});
	for (let index = 0; index < 5; index += 1)
		record('github__create_pr', 'ok', index, 100 + index * 10);
	record('sentry__list_events', 'error', 2, 900);
	record('sentry__list_events', 'ok', 3, 300);
	record('github__create_pr', 'timeout', 4, 60_000);
	record('old__tool', 'ok', 60 * 30, 100); // 30 days ago: outside every window
});

describe('status filtering', () => {
	test('only known statuses reach the query', () => {
		expect(asCallStatus('timeout')).toBe('timeout');
		expect(asCallStatus('whatever')).toBeUndefined();
		expect(asCallStatus(null)).toBeUndefined();
	});
});

describe('queryCallLog', () => {
	test('returns newest first with joined names', () => {
		const { rows, total } = queryCallLog({ sinceHours: 24 });
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0].calledAt >= rows[rows.length - 1].calledAt).toBe(true);
		expect(rows[0].keyName).toBe('laptop');
		expect(rows[0].upstreamSlug).toBe('usage-host');
		expect(total).toBeGreaterThanOrEqual(rows.length);
	});

	test('filters combine, and paging is offset-based', () => {
		const errors = queryCallLog({ sinceHours: 24, status: 'error' });
		expect(errors.rows.every((row) => row.status === 'error')).toBe(true);
		const paged = queryCallLog({ sinceHours: 24, limit: 2, offset: 2 });
		expect(paged.rows).toHaveLength(2);
		const byTool = queryCallLog({ sinceHours: 24, tool: 'sentry__list_events' });
		expect(byTool.rows.every((row) => row.tool === 'sentry__list_events')).toBe(true);
	});

	test('a window excludes older detail', () => {
		// the fixture has rows at 30 days and at a few minutes ago
		expect(queryCallLog({ sinceHours: 24 * 40 }).rows.some((row) => row.tool === 'old__tool')).toBe(
			true
		);
		expect(queryCallLog({ sinceHours: 24 }).rows.some((row) => row.tool === 'old__tool')).toBe(
			false
		);
		// every recent row is minutes old, so a 1h window still sees them all
		expect(queryCallLog({ sinceHours: 1 }).rows.length).toBe(overview().calls24h);
	});
});

describe('aggregates', () => {
	test('overview counts, error rate and percentiles are consistent', () => {
		const stats = overview();
		expect(stats.calls24h).toBeGreaterThanOrEqual(8);
		expect(stats.errors24h).toBe(2); // one error + one timeout
		expect(stats.errorRate).toBeCloseTo(stats.errors24h / stats.calls24h, 5);
		expect(stats.p50Ms).toBeGreaterThan(0);
		expect(stats.p95Ms).toBeGreaterThanOrEqual(stats.p50Ms);
	});

	test('topTools ranks by call volume', () => {
		const top = topTools(24, 5);
		expect(top[0].tool).toBe('github__create_pr');
		expect(top[0].calls).toBeGreaterThan(top[1]?.calls ?? 0);
		expect(top[0].errors).toBe(1); // the timeout
	});

	test('hourlySeries covers the whole window, zeros included', () => {
		const series = hourlySeries(6);
		expect(series).toHaveLength(6);
		expect(series.every((point) => typeof point.calls === 'number')).toBe(true);
		const total = hourlySeries(24).reduce((sum, point) => sum + point.calls, 0);
		expect(total).toBe(overview().calls24h);
	});

	test('usageByKey attributes calls to the key name', () => {
		const byKey = usageByKey(24);
		expect(byKey.find((entry) => entry.keyName === 'laptop')?.calls).toBe(overview().calls24h);
	});
});

describe('hourly rollup', () => {
	test('aggregates the previous hour into usage_hourly and is idempotent', () => {
		const rows = rollupHourly(getDb(), new Date(Date.now() + 3_600_000));
		const stored = getDb().select().from(usageHourly).all();
		expect(stored.length).toBe(rows);
		rollupHourly(getDb(), new Date(Date.now() + 3_600_000));
		expect(getDb().select().from(usageHourly).all().length).toBe(stored.length);
		expect(stored.reduce((sum, row) => sum + row.calls, 0)).toBeGreaterThan(0);
	});
});

describe('CSV export', () => {
	test('quotes only what needs quoting, and never lets a value forge columns', () => {
		const { rows } = queryCallLog({ sinceHours: 24, status: 'error' });
		const csv = callsToCsv(rows);
		const [header, ...lines] = csv.trim().split('\r\n');
		expect(header.split(',')).toHaveLength(11);
		expect(lines.length).toBe(rows.length);
		// plain error text needs no quoting
		expect(lines[0].includes('boom for')).toBe(true);

		// a hostile value must stay inside one field
		const hostile = callsToCsv([
			{
				id: 'x',
				requestId: 'r',
				keyName: 'a,b "quoted"\nnewline',
				upstreamSlug: null,
				tool: 't',
				upstreamTool: null,
				status: 'ok',
				durationMs: 1,
				reqBytes: 1,
				resBytes: 1,
				error: null,
				calledAt: '2026-01-01T00:00:00.000Z'
			}
		]);
		const [, ...hostileLines] = hostile.trim().split('\r\n');
		// the embedded newline stays inside the quoted field, so the row count is 1
		expect(hostileLines).toHaveLength(1);
		expect(hostileLines[0]).toContain('"a,b ""quoted""');
	});

	test('an empty result is still a valid file', () => {
		const csv = callsToCsv([]);
		expect(csv.trim().split('\r\n')).toHaveLength(1);
	});
});

describe('cleanup', () => {
	test('fixture directory is removed', () => {
		rmSync(dir, { recursive: true, force: true });
	});
});
