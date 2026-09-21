import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	deleteProfile,
	getSnapshot,
	listUpstreams,
	RegistryError,
	setProfileLinks,
	updateProfile
} from '$lib/server/registry';
import { activeKeysForProfile } from '$lib/server/registry';
import type { ProfileLink } from '$lib/server/registry';
import { assertValidPatterns, isAllowed } from '$lib/shared/glob';

export const load = (async ({ params }) => {
	const profile = getSnapshot().profilesById.get(params.id);
	if (!profile) throw error(404, 'Profile not found');

	const upstreams = listUpstreams();
	const rows = upstreams.map((record) => {
		const link = profile.links.find((entry) => entry.upstream.slug === record.slug);
		// preview the effect of the current rules: the same predicate the gateway uses,
		// evaluated against the names it will actually serve
		const names = record.status?.toolNames ?? [];
		const visible = link
			? names.filter((name) => isAllowed(name, { allow: link.allowGlobs, deny: link.denyGlobs }))
					.length
			: 0;
		return {
			slug: record.slug,
			name: record.name,
			inScope: link !== undefined,
			allow: (link?.allowGlobs ?? ['*']).join(' '),
			deny: (link?.denyGlobs ?? []).join(' '),
			toolsCount: record.toolsCount ?? 0,
			visible,
			// false when no handshake has ever run: show "unknown", never a fake 0
			namesAvailable: (record.status?.toolNames?.length ?? 0) > 0
		};
	});

	return {
		profile: {
			id: profile.id,
			name: profile.name,
			rateLimitRpm: profile.rateLimitRpm,
			dailyCallQuota: profile.dailyCallQuota,
			maxConcurrency: profile.maxConcurrency,
			defaultTimeoutMs: profile.defaultTimeoutMs
		},
		rows,
		blockedBy: activeKeysForProfile(profile.id).map((key) => ({ id: key.id, name: key.name })),
		totalTools: rows.reduce((total, row) => total + row.visible, 0)
	};
}) satisfies PageServerLoad;

export const actions = {
	save: async ({ params, request, locals, getClientAddress }) => {
		const data = await request.formData();
		const profile = getSnapshot().profilesById.get(params.id);
		if (!profile) throw error(404, 'Profile not found');

		const inScope = new Set(data.getAll('inScope') as string[]);
		const bySlug = new Map(listUpstreams().map((record) => [record.slug, record.id]));

		const links: ProfileLink[] = [];
		const patternErrors: string[] = [];
		for (const slug of inScope) {
			const upstreamId = bySlug.get(slug);
			if (!upstreamId) continue;
			const allow = tokens(String(data.get(`allow:${slug}`) ?? ''));
			const deny = tokens(String(data.get(`deny:${slug}`) ?? ''));
			try {
				assertValidPatterns(allow, `${slug} allow`);
				assertValidPatterns(deny, `${slug} deny`);
			} catch (caught) {
				patternErrors.push((caught as Error).message);
				continue;
			}
			links.push({ upstreamId, allowGlobs: allow.length > 0 ? allow : ['*'], denyGlobs: deny });
		}

		if (patternErrors.length > 0) return fail(400, { error: patternErrors[0] as string });
		if (links.length === 0) return fail(400, { error: 'Keep at least one upstream in scope.' });

		const actor = { actorId: locals.user?.id ?? null, ip: getClientAddress() };
		try {
			setProfileLinks(profile.id, links, actor);
			updateProfile(
				profile.id,
				{
					rateLimitRpm: positiveInt(data.get('rateLimitRpm'), profile.rateLimitRpm),
					dailyCallQuota: nonNegativeInt(data.get('dailyCallQuota'), profile.dailyCallQuota),
					maxConcurrency: positiveInt(data.get('maxConcurrency'), profile.maxConcurrency)
				},
				actor
			);
		} catch (caught) {
			if (caught instanceof RegistryError) return fail(400, { error: caught.message });
			throw caught;
		}
		throw redirect(303, `/admin/profiles/${profile.id}?saved=1`);
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const actor = { actorId: locals.user?.id ?? null, ip: getClientAddress() };
		try {
			deleteProfile(params.id, actor);
		} catch (caught) {
			if (caught instanceof RegistryError) return fail(400, { error: caught.message });
			throw caught;
		}
		throw redirect(303, '/admin/profiles');
	}
} satisfies Actions;

function tokens(value: string): string[] {
	return value
		.split(/[\s,]+/)
		.map((token) => token.trim())
		.filter((token) => token !== '');
}

function positiveInt(value: FormDataEntryValue | null, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: FormDataEntryValue | null, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ''), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
