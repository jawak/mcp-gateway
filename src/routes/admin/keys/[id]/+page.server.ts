import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	getApiKeyById,
	resumeApiKey,
	rotateApiKey,
	revokeApiKey,
	setIpAllowlist,
	suspendApiKey
} from '$lib/server/governance/apikey';
import { getSnapshot, RegistryError } from '$lib/server/registry';
import { usageByKey } from '$lib/server/observability/usage-query';

export const load = (async ({ params }) => {
	const key = getApiKeyById(params.id);
	if (!key) throw error(404, 'API key not found');
	const profile = getSnapshot().profilesById.get(key.profileId);
	return {
		key,
		profileName: profile?.name ?? '(missing profile)',
		profileOk: profile !== undefined,
		expired: key.expiresAt !== null && new Date(key.expiresAt).getTime() < Date.now(),
		usage: usageByKey(24).find((entry) => entry.keyName === key.name) ?? {
			keyName: key.name,
			calls: 0,
			errors: 0
		}
	};
}) satisfies PageServerLoad;

/**
 * Key lifecycle actions.
 *
 * Every one of them ends live sessions within seconds (via the event bus), because
 * a revoked key that keeps working until an idle timeout expires is not revoked.
 */
export const actions = {
	rotate: async ({ params, locals, getClientAddress }) => {
		try {
			const { plaintext, key } = rotateApiKey(params.id, {
				actorId: locals.user?.id ?? null,
				ip: getClientAddress()
			});
			return { rotated: { id: key.id, plaintext } };
		} catch (caught) {
			if (caught instanceof RegistryError) return fail(400, { error: caught.message });
			throw caught;
		}
	},

	revoke: async ({ params, locals, getClientAddress }) => {
		try {
			revokeApiKey(params.id, { actorId: locals.user?.id ?? null, ip: getClientAddress() });
		} catch (caught) {
			if (caught instanceof RegistryError) return fail(400, { error: caught.message });
			throw caught;
		}
		throw redirect(303, '/admin/keys');
	},

	suspend: async ({ params, request, locals, getClientAddress }) => {
		const data = await request.formData();
		const actor = { actorId: locals.user?.id ?? null, ip: getClientAddress() };
		try {
			if (data.get('resume') === 'true') resumeApiKey(params.id, actor);
			else suspendApiKey(params.id, actor);
		} catch (caught) {
			if (caught instanceof RegistryError) return fail(400, { error: caught.message });
			throw caught;
		}
		throw redirect(303, `/admin/keys/${params.id}?saved=1`);
	},

	allowlist: async ({ params, request, locals, getClientAddress }) => {
		const data = await request.formData();
		const entries = String(data.get('ipAllowlist') ?? '')
			.split(/[\s,]+/)
			.map((entry) => entry.trim())
			.filter((entry) => entry !== '');
		try {
			setIpAllowlist(params.id, entries, {
				actorId: locals.user?.id ?? null,
				ip: getClientAddress()
			});
		} catch (caught) {
			if (caught instanceof RegistryError) return fail(400, { error: caught.message });
			throw caught;
		}
		throw redirect(303, `/admin/keys/${params.id}?saved=1`);
	}
} satisfies Actions;
