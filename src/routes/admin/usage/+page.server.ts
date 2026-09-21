import type { PageServerLoad } from './$types';
import {
	hourlySeries,
	overview,
	topTools,
	usageByKey
} from '$lib/server/observability/usage-query';

const WINDOWS = [1, 6, 24, 72, 168];

export const load = (({ url }) => {
	const requested = Number.parseInt(url.searchParams.get('hours') ?? '24', 10);
	const hours = WINDOWS.includes(requested) ? requested : 24;
	return {
		hours,
		windows: WINDOWS,
		stats: overview(),
		series: hourlySeries(hours),
		top: topTools(hours, 15),
		byKey: usageByKey(hours)
	};
}) satisfies PageServerLoad;
