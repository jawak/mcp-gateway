import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { listApiKeys } from '$lib/server/governance/apikey';
import { listProfiles, listUpstreams } from '$lib/server/registry';
import { latestHealthByUpstream } from '$lib/server/upstream/health';

/**
 * The hook already refuses unauthenticated and non-admin writes; this makes the
 * identity available to every admin page and turns a missing session into a
 * redirect even if a route forgets to check.
 */
export const load = (({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	}

	// Small counters for the sidebar. Cheap (a few indexed reads) and useful on
	// every page: an operator should see "2 upstreams down" without opening a tab.
	const upstreams = listUpstreams();
	const health = latestHealthByUpstream();
	const down = upstreams.filter((record) => {
		const state = health.get(record.id)?.status;
		return state === 'down' || state === 'unconfigured';
	}).length;

	return {
		user: { email: locals.user.email, role: locals.user.role },
		/** Viewers get a read-only UI: no destructive action is offered at all. */
		canWrite: locals.user.role === 'admin',
		summary: {
			upstreams: upstreams.length,
			profiles: listProfiles().length,
			keys: listApiKeys().filter((key) => key.status === 'active').length,
			down
		}
	};
}) satisfies LayoutServerLoad;
