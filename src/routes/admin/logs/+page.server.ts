import type { PageServerLoad } from './$types';
import { queryCallLog, asCallStatus, type LogFilter } from '$lib/server/observability/usage-query';
import { getSnapshot } from '$lib/server/registry';
import { listApiKeys } from '$lib/server/governance/apikey';

const PER_PAGE = 50;
const HOURS_OPTIONS = [1, 6, 24, 72, 168];

export const load = (({ url }) => {
	const hours = HOURS_OPTIONS.includes(Number(url.searchParams.get('hours')))
		? Number(url.searchParams.get('hours'))
		: 24;
	const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const requestId = url.searchParams.get('request');

	const filter: LogFilter = { sinceHours: hours, limit: PER_PAGE, offset: (page - 1) * PER_PAGE };
	const status = asCallStatus(url.searchParams.get('status'));
	if (status) filter.status = status;
	if (url.searchParams.get('key')) filter.keyId = url.searchParams.get('key') as string;
	if (url.searchParams.get('tool')) filter.tool = url.searchParams.get('tool') as string;

	// a request-id lookup is the debugging path and should ignore the time window
	if (requestId) {
		const found = queryCallLog({ limit: 50 }, undefined).rows.filter(
			(row) => row.requestId === requestId
		);
		return {
			rows: found,
			total: found.length,
			page: 1,
			perPage: PER_PAGE,
			hours,
			status: status ?? '',
			keyId: '',
			tool: '',
			requestId,
			keys: listApiKeys().map((key) => ({ id: key.id, name: key.name })),
			upstreams: [...getSnapshot().upstreamsBySlug.keys()],
			foundViaRequestId: true
		};
	}

	const { rows, total } = queryCallLog(filter);
	return {
		rows,
		total,
		page,
		perPage: PER_PAGE,
		hours,
		status: status ?? '',
		keyId: url.searchParams.get('key') ?? '',
		tool: url.searchParams.get('tool') ?? '',
		requestId: '',
		keys: listApiKeys().map((key) => ({ id: key.id, name: key.name })),
		upstreams: [...getSnapshot().upstreamsBySlug.keys()],
		foundViaRequestId: false
	};
}) satisfies PageServerLoad;
