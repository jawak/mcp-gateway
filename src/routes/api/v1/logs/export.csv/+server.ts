import type { RequestHandler } from './$types';
import {
	callsToCsv,
	queryCallLog,
	asCallStatus,
	type LogFilter
} from '$lib/server/observability/usage-query';

const MAX_ROWS = 100_000;

/**
 * CSV export of the call log (T-36).
 *
 * Same filters as the page, hard row cap so an export cannot be turned into a
 * memory problem, and `no-store` because the content is per-tenant and changes.
 */
export const GET = (({ url }) => {
	const filter: LogFilter = { sinceHours: 24, limit: MAX_ROWS };
	const hours = Number.parseInt(url.searchParams.get('hours') ?? '24', 10);
	if (Number.isFinite(hours) && hours > 0) filter.sinceHours = Math.min(hours, 24 * 30);
	const status = asCallStatus(url.searchParams.get('status'));
	if (status) filter.status = status;
	const key = url.searchParams.get('key');
	if (key) filter.keyId = key;
	const tool = url.searchParams.get('tool');
	if (tool) filter.tool = tool;

	const { rows } = queryCallLog(filter);
	const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
	return new Response(callsToCsv(rows), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="mcp-calls-${stamp}.csv"`,
			'cache-control': 'no-store',
			'x-row-count': String(rows.length)
		}
	});
}) satisfies RequestHandler;
