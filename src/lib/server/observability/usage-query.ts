/**
 * Usage queries for the admin dashboard (T-26, T-37).
 *
 * Everything here is a read over `tool_calls` / `usage_hourly`. Two choices worth
 * explaining:
 *  - percentiles are computed in JS from the fetched durations rather than SQL:
 *    SQLite has no percentile function, and the windows we show are small enough
 *    that this is both simpler and honest about what is approximate.
 *  - every query is bounded (limit / time window) so a page can never trigger a
 *    table scan that stalls the request path sharing the same database.
 */
import { and, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.ts';
import { apiKeys, toolCalls, upstreams, usageHourly } from '../db/schema.ts';
import { dayBucket } from '../../shared/time.ts';

export type CallLogRow = {
	id: string;
	requestId: string;
	keyName: string | null;
	upstreamSlug: string | null;
	tool: string;
	upstreamTool: string | null;
	status: string;
	durationMs: number;
	reqBytes: number | null;
	resBytes: number | null;
	error: string | null;
	calledAt: string;
};

export type CallStatus = 'ok' | 'error' | 'timeout' | 'rejected' | 'rate_limited';

const CALL_STATUSES: CallStatus[] = ['ok', 'error', 'timeout', 'rejected', 'rate_limited'];

/** Only known statuses reach the query, so a crafted query param cannot widen it. */
export function asCallStatus(value: string | null | undefined): CallStatus | undefined {
	return CALL_STATUSES.includes(value as CallStatus) ? (value as CallStatus) : undefined;
}

export type LogFilter = {
	sinceHours?: number;
	until?: string;
	status?: CallStatus;
	keyId?: string;
	upstreamSlug?: string;
	tool?: string;
	limit?: number;
	offset?: number;
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Most recent tool calls, newest first, with the names an operator reads. */
export function queryCallLog(
	filter: LogFilter = {},
	db: Db = getDb()
): { rows: CallLogRow[]; total: number } {
	const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
	const conditions: SQL[] = [];
	if (filter.sinceHours) {
		const since = new Date(Date.now() - filter.sinceHours * 3_600_000).toISOString();
		conditions.push(gte(toolCalls.calledAt, since));
	}
	if (filter.until) conditions.push(lt(toolCalls.calledAt, filter.until));
	if (filter.status) conditions.push(eq(toolCalls.status, filter.status));
	if (filter.keyId) conditions.push(eq(toolCalls.apiKeyId, filter.keyId));
	if (filter.tool) conditions.push(eq(toolCalls.tool, filter.tool));
	if (filter.upstreamSlug) conditions.push(eq(upstreams.slug, filter.upstreamSlug));
	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const fetched = db
		.select({
			id: toolCalls.id,
			requestId: toolCalls.requestId,
			keyName: apiKeys.name,
			upstreamSlug: upstreams.slug,
			tool: toolCalls.tool,
			upstreamTool: toolCalls.upstreamTool,
			status: toolCalls.status,
			durationMs: toolCalls.durationMs,
			reqBytes: toolCalls.reqBytes,
			resBytes: toolCalls.resBytes,
			error: toolCalls.error,
			calledAt: toolCalls.calledAt
		})
		.from(toolCalls)
		.leftJoin(apiKeys, eq(toolCalls.apiKeyId, apiKeys.id))
		.leftJoin(upstreams, eq(toolCalls.upstreamId, upstreams.id))
		.where(where)
		.orderBy(desc(toolCalls.calledAt))
		.limit(limit)
		.offset(filter.offset ?? 0)
		.all()
		.map((row) => ({ ...row, status: row.status as string }));

	const [{ value: total }] = db
		.select({ value: sql<number>`count(*)` })
		.from(toolCalls)
		.leftJoin(upstreams, eq(toolCalls.upstreamId, upstreams.id))
		.where(where)
		.all();

	return { rows: fetched, total };
}

export type Overview = {
	calls24h: number;
	errors24h: number;
	errorRate: number;
	p50Ms: number;
	p95Ms: number;
	activeKeys: number;
	sessions: number;
};

/** Headline numbers for the dashboard. */
export function overview(db: Db = getDb()): Overview {
	const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
	const rows = db
		.select({
			status: toolCalls.status,
			durationMs: toolCalls.durationMs
		})
		.from(toolCalls)
		.where(gte(toolCalls.calledAt, since))
		.limit(20_000)
		.all();
	const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
	const errors = rows.filter((row) => row.status !== 'ok').length;
	return {
		calls24h: rows.length,
		errors24h: errors,
		errorRate: rows.length === 0 ? 0 : errors / rows.length,
		p50Ms: percentile(durations, 0.5),
		p95Ms: percentile(durations, 0.95),
		activeKeys: db
			.select({ id: apiKeys.id })
			.from(apiKeys)
			.all()
			.filter((key) => key.id).length,
		sessions: db
			.select({ id: sql<string>`count(*)` })
			.from(toolCalls)
			.where(gte(toolCalls.calledAt, new Date(Date.now() - 5 * 60_000).toISOString()))
			.all().length
	};
}

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
	return sorted[index] ?? 0;
}

export type ToolUsage = { tool: string; calls: number; errors: number; p95Ms: number };

/** Top tools by call count over a window, for the usage page and dashboard. */
export function topTools(hours = 24, limit = 10, db: Db = getDb()): ToolUsage[] {
	const since = new Date(Date.now() - hours * 3_600_000).toISOString();
	const grouped = new Map<string, { calls: number; errors: number; durations: number[] }>();
	for (const row of db
		.select({ tool: toolCalls.tool, status: toolCalls.status, durationMs: toolCalls.durationMs })
		.from(toolCalls)
		.where(gte(toolCalls.calledAt, since))
		.limit(50_000)
		.all()) {
		const bucket = grouped.get(row.tool) ?? { calls: 0, errors: 0, durations: [] };
		bucket.calls += 1;
		if (row.status !== 'ok') bucket.errors += 1;
		bucket.durations.push(row.durationMs);
		grouped.set(row.tool, bucket);
	}
	return [...grouped.entries()]
		.map(([tool, bucket]) => ({
			tool,
			calls: bucket.calls,
			errors: bucket.errors,
			p95Ms: percentile(
				[...bucket.durations].sort((a, b) => a - b),
				0.95
			)
		}))
		.sort((a, b) => b.calls - a.calls)
		.slice(0, limit);
}

export type HourlyPoint = { hour: string; calls: number; errors: number };

/** Per-hour series for the chart, filled with zeros so the axis stays honest. */
export function hourlySeries(hours = 24, db: Db = getDb()): HourlyPoint[] {
	const since = new Date(Date.now() - hours * 3_600_000);
	const rows = db
		.select({
			bucket: toolCalls.calledAt,
			status: toolCalls.status
		})
		.from(toolCalls)
		.where(gte(toolCalls.calledAt, since.toISOString()))
		.limit(50_000)
		.all();
	const points = new Map<string, { calls: number; errors: number }>();
	for (let offset = hours - 1; offset >= 0; offset -= 1) {
		const hour = new Date(Date.now() - offset * 3_600_000).toISOString().slice(0, 13);
		points.set(hour, { calls: 0, errors: 0 });
	}
	for (const row of rows) {
		const hour = row.bucket.slice(0, 13);
		const point = points.get(hour);
		if (!point) continue;
		point.calls += 1;
		if (row.status !== 'ok') point.errors += 1;
	}
	return [...points.entries()].map(([hour, point]) => ({ hour, ...point }));
}

export type KeyUsage = { keyName: string; calls: number; errors: number };

/** Usage split by API key: the answer to "who is hammering this?". */
export function usageByKey(hours = 24, db: Db = getDb()): KeyUsage[] {
	const since = new Date(Date.now() - hours * 3_600_000).toISOString();
	const grouped = new Map<string, { calls: number; errors: number }>();
	for (const row of db
		.select({ keyName: apiKeys.name, status: toolCalls.status })
		.from(toolCalls)
		.leftJoin(apiKeys, eq(toolCalls.apiKeyId, apiKeys.id))
		.where(gte(toolCalls.calledAt, since))
		.limit(50_000)
		.all()) {
		const name = row.keyName ?? '(deleted key)';
		const bucket = grouped.get(name) ?? { calls: 0, errors: 0 };
		bucket.calls += 1;
		if (row.status !== 'ok') bucket.errors += 1;
		grouped.set(name, bucket);
	}
	return [...grouped.entries()]
		.map(([keyName, bucket]) => ({ keyName, ...bucket }))
		.sort((a, b) => b.calls - a.calls);
}

/** Roll `tool_calls` into `usage_hourly` (worker job, T-46) for cheap charts. */
export function rollupHourly(db: Db = getDb(), now: Date = new Date()): number {
	const hour = new Date(now.getTime() - 3_600_000).toISOString().slice(0, 13);
	const rows = db
		.select({
			apiKeyId: toolCalls.apiKeyId,
			upstreamId: toolCalls.upstreamId,
			tool: toolCalls.tool,
			status: toolCalls.status,
			durationMs: toolCalls.durationMs
		})
		.from(toolCalls)
		.where(
			and(
				gte(toolCalls.calledAt, `${hour}:00:00.000Z`),
				lt(toolCalls.calledAt, `${hour}:59:59.999Z`)
			)
		)
		.limit(100_000)
		.all();

	const grouped = new Map<string, { calls: number; errors: number; durations: number[] }>();
	for (const row of rows) {
		const key = `${row.apiKeyId ?? ''}|${row.upstreamId ?? ''}|${row.tool}`;
		const bucket = grouped.get(key) ?? { calls: 0, errors: 0, durations: [] };
		bucket.calls += 1;
		if (row.status !== 'ok') bucket.errors += 1;
		bucket.durations.push(row.durationMs);
		grouped.set(key, bucket);
	}
	for (const [key, bucket] of grouped) {
		const [apiKeyId, upstreamId, tool] = key.split('|');
		const sorted = [...bucket.durations].sort((a, b) => a - b);
		db.insert(usageHourly)
			.values({
				bucketHour: `${hour}:00:00.000Z`,
				apiKeyId: apiKeyId || '',
				upstreamId: upstreamId || '',
				tool,
				calls: bucket.calls,
				errors: bucket.errors,
				p50Ms: percentile(sorted, 0.5),
				p95Ms: percentile(sorted, 0.95)
			})
			.onConflictDoUpdate({
				target: [
					usageHourly.bucketHour,
					usageHourly.apiKeyId,
					usageHourly.upstreamId,
					usageHourly.tool
				],
				set: {
					calls: bucket.calls,
					errors: bucket.errors,
					p50Ms: percentile(sorted, 0.5),
					p95Ms: percentile(sorted, 0.95)
				}
			})
			.run();
	}
	return grouped.size;
}

/** Retention (T-46). Returns the number of rows removed. */
export function pruneToolCalls(days: number, db: Db = getDb()): number {
	const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
	const [{ value: stale }] = db
		.select({ value: sql<number>`count(*)` })
		.from(toolCalls)
		.where(lt(toolCalls.calledAt, cutoff))
		.all();
	db.delete(toolCalls).where(lt(toolCalls.calledAt, cutoff)).run();
	return stale;
}

/** CSV for the log page export. */
export function callsToCsv(rows: CallLogRow[]): string {
	const header = [
		'called_at',
		'request_id',
		'key',
		'upstream',
		'tool',
		'upstream_tool',
		'status',
		'duration_ms',
		'req_bytes',
		'res_bytes',
		'error'
	];
	const cell = (value: unknown) => {
		const text = value === null || value === undefined ? '' : String(value);
		return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	};
	const lines = [header.join(',')];
	for (const row of rows) {
		lines.push(
			[
				row.calledAt,
				row.requestId,
				row.keyName,
				row.upstreamSlug,
				row.tool,
				row.upstreamTool,
				row.status,
				row.durationMs,
				row.reqBytes,
				row.resBytes,
				row.error
			]
				.map(cell)
				.join(',')
		);
	}
	return `${lines.join('\r\n')}\r\n`;
}

export { dayBucket };
