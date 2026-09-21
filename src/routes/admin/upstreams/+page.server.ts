import { redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { deleteUpstream, listUpstreams, setUpstreamEnabled } from '$lib/server/registry';
import { testUpstream } from '$lib/server/governance/upstream-test';
import { getUpstreamPool } from '$lib/server/upstream/pool';
import { latestHealthByUpstream } from '$lib/server/upstream/health';
import { RegistryError } from '$lib/server/registry';
import { fail } from '@sveltejs/kit';

/**
 * Upstream list. Health comes from the newest probe rather than a live check: this
 * page loads often, and probing every upstream on every visit would spawn every
 * `lazy` child process just to render a table.
 */
export const load = (() => {
	const health = latestHealthByUpstream();
	const rows = listUpstreams().map((record) => {
		const latest = health.get(record.id);
		return {
			// rows are addressed by id for writes and by slug for URLs
			id: record.id,
			slug: record.slug,
			name: record.name,
			transport: record.transport,
			enabled: record.enabled,
			pin: record.pin,
			toolsCount: record.toolsCount ?? 0,
			status: latest?.status ?? (record.enabled ? 'unknown' : 'down'),
			latencyMs: latest?.latencyMs ?? null,
			error: latest?.error ?? record.lastError ?? null
		};
	});
	return { rows, live: getUpstreamPool().stats() };
}) satisfies PageServerLoad;

export const actions = {
	/** Toggle without deleting: maintenance should not destroy anyone's config. */
	toggle: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const id = String(data.get('id') ?? '');
		const enabled = data.get('enabled') === 'true';
		try {
			setUpstreamEnabled(id, enabled, { actorId: locals.user?.id ?? null, ip: getClientAddress() });
		} catch (error) {
			if (error instanceof RegistryError) return fail(400, { error: error.message });
			throw error;
		}
		throw redirect(303, '/admin/upstreams');
	},

	/** Force a probe now, instead of waiting for the worker interval. */
	check: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const slug = String(data.get('slug') ?? '');
		const result = await testUpstream(slug, getUpstreamPool(), {
			actorId: locals.user?.id ?? null,
			ip: getClientAddress()
		});
		throw redirect(
			303,
			`/admin/upstreams/${slug}${result.ok ? '' : `?error=${encodeURIComponent(result.message ?? 'failed')}`}`
		);
	},

	remove: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const id = String(data.get('id') ?? '');
		try {
			deleteUpstream(id, { actorId: locals.user?.id ?? null, ip: getClientAddress() });
		} catch (error) {
			if (error instanceof RegistryError) return fail(400, { error: error.message });
			throw error;
		}
		throw redirect(303, '/admin/upstreams');
	}
} satisfies Actions;
