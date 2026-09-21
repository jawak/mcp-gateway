import type { RequestHandler } from './$types';
import {
	hourlySeries,
	overview,
	topTools,
	usageByKey
} from '$lib/server/observability/usage-query';

const WINDOWS = [1, 6, 24, 72, 168];

/** Usage JSON for the charts (T-37). Same numbers the dashboard shows. */
export const GET = (({ url }) => {
	const requested = Number.parseInt(url.searchParams.get('hours') ?? '24', 10);
	const hours = WINDOWS.includes(requested) ? requested : 24;
	return new Response(
		JSON.stringify({
			hours,
			overview: overview(),
			series: hourlySeries(hours),
			topTools: topTools(hours, 20),
			byKey: usageByKey(hours)
		}),
		{ headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
	);
}) satisfies RequestHandler;
