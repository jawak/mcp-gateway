import type { PageServerLoad } from './$types';
import { listProfiles, listUpstreams } from '$lib/server/registry';
import { listApiKeys } from '$lib/server/governance/apikey';
import { latestHealthByUpstream } from '$lib/server/upstream/health';
import { liveSessionCount, overview, topTools } from '$lib/server/observability/usage-query';

import { healthzPayload } from '../../handle';

export const load = (async ({ url }) => {
	const upstreams = listUpstreams();
	const health = latestHealthByUpstream();
	const keys = listApiKeys();
	const activeKeys = keys.filter((key) => key.status === 'active' && !isExpired(key.expiresAt));
	const stats = overview();

	// rows keep their per-upstream health next to the counts an operator acts on
	const rows = upstreams.map((record) => {
		const latest = health.get(record.id);
		return {
			slug: record.slug,
			name: record.name,
			transport: record.transport,
			enabled: record.enabled,
			toolsCount: record.toolsCount,
			status: latest?.status ?? (record.enabled ? 'unknown' : 'down'),
			latencyMs: latest?.latencyMs ?? null,
			error: latest?.error ?? record.lastError ?? null
		};
	});

	const down = rows.filter((row) => row.status === 'down' || row.status === 'unconfigured');

	return {
		stats,
		down,
		rows: rows.slice(0, 6),
		upstreamCount: upstreams.length,
		profileCount: listProfiles().length,
		activeKeyCount: activeKeys.length,
		hasUpstream: upstreams.length > 0,
		hasProfile: listProfiles().length > 0,
		hasKey: activeKeys.length > 0,
		liveSessions: liveSessionCount(),
		top: topTools(24, 5),
		endpoint: publicEndpoint(url),
		healthz: healthzPayload('')
	};
}) satisfies PageServerLoad;

function isExpired(value: string | null): boolean {
	return value !== null && new Date(value).getTime() < Date.now();
}

/**
 * The URL clients should dial. Derived from the request so it is correct behind a
 * reverse proxy, falling back to MCPGW_PUBLIC_URL when the deployment set it.
 */
function publicEndpoint(url: URL): string {
	const configured = process.env.MCPGW_PUBLIC_URL;
	if (configured) return `${configured.replace(/\/$/, '')}/mcp`;
	return `${url.protocol}//${url.host}/mcp`;
}
