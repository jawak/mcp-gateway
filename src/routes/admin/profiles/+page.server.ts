import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createProfile, listProfiles, RegistryError } from '$lib/server/registry';
import { listUpstreams } from '$lib/server/registry';

export const load = (() => {
	const upstreams = listUpstreams();
	return {
		profiles: listProfiles().map((profile) => ({
			id: profile.id,
			name: profile.name,
			rateLimitRpm: profile.rateLimitRpm,
			dailyCallQuota: profile.dailyCallQuota,
			maxConcurrency: profile.maxConcurrency,
			upstreams: profile.links.map((link) => link.upstream.slug),
			visibleTools: profile.links.reduce(
				(total, link) => total + (link.upstream.toolsCount ?? 0),
				0
			)
		})),
		upstreams: upstreams.map((record) => ({
			slug: record.slug,
			name: record.name,
			toolsCount: record.toolsCount ?? 0
		}))
	};
}) satisfies PageServerLoad;

export const actions = {
	create: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) return fail(400, { error: 'A profile name is required.' });
		const selected = (data.getAll('upstream') as string[]).filter((slug) => slug !== '');
		if (selected.length === 0) {
			return fail(400, { error: 'Pick at least one upstream — an empty profile exposes nothing.' });
		}

		const bySlug = new Map(listUpstreams().map((record) => [record.slug, record.id]));
		try {
			const profile = createProfile(
				{
					name,
					rateLimitRpm: positiveInt(data.get('rateLimitRpm'), 120),
					dailyCallQuota: nonNegativeInt(data.get('dailyCallQuota'), 1_000),
					maxConcurrency: positiveInt(data.get('maxConcurrency'), 10),
					links: selected
						.map((slug) => ({ upstreamId: bySlug.get(slug) ?? '' }))
						.filter((link) => link.upstreamId !== '')
				},
				{ actorId: locals.user?.id ?? null, ip: getClientAddress() }
			);
			throw redirect(303, `/admin/profiles/${profile.id}`);
		} catch (error) {
			if (error instanceof RegistryError) return fail(400, { error: error.message });
			throw error;
		}
	}
} satisfies Actions;

function positiveInt(value: FormDataEntryValue | null, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: FormDataEntryValue | null, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
