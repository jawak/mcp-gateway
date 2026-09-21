import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createApiKey } from '$lib/server/governance/apikey';
import { RegistryError, getSnapshot } from '$lib/server/registry';

export const load = (() => ({
	profiles: [...getSnapshot().profilesById.values()].map((profile) => ({
		id: profile.id,
		name: profile.name,
		rateLimitRpm: profile.rateLimitRpm
	}))
})) satisfies PageServerLoad;

/**
 * Issue a key.
 *
 * The plaintext travels back exactly once, through the rendered page: the database
 * keeps only a hash, so this is the only moment it exists in recoverable form. The
 * page it lands on is where the operator copies it into their client.
 */
export const actions = {
	default: async ({ request, locals, getClientAddress, url }) => {
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		const profileId = String(data.get('profileId') ?? '');
		const validityDays = Number.parseInt(String(data.get('validityDays') ?? '90'), 10);
		const ipAllowlist = String(data.get('ipAllowlist') ?? '')
			.split(/[\s,]+/)
			.map((entry) => entry.trim())
			.filter((entry) => entry !== '');

		if (!name)
			return fail(400, {
				error: 'Give the key a name you will recognise later (e.g. “arya-macbook”).'
			});
		if (!profileId)
			return fail(400, { error: 'Pick a profile — it decides what this key may call.' });
		if (ipAllowlist.length === 0) {
			// not a hard requirement, but the common case wants an explicit choice
			const explicit = data.get('allowAnyIp') === 'on';
			if (!explicit) {
				return fail(400, {
					error: 'Restrict the key to known addresses, or confirm “allow any address” knowingly.'
				});
			}
		}

		const validity =
			Number.isFinite(validityDays) && validityDays > 0 ? Math.min(validityDays, 3650) : 90;
		try {
			const { plaintext, key } = createApiKey(
				{
					name,
					profileId,
					ipAllowlist,
					expiresAt: new Date(Date.now() + validity * 86_400_000).toISOString(),
					createdBy: locals.user?.id ?? null
				},
				{ actorId: locals.user?.id ?? null, ip: getClientAddress() }
			);
			// the key travels as a one-time query param to the detail page
			return { created: { id: key.id, plaintext }, endpoint: `${url.origin}/mcp` };
		} catch (error) {
			if (error instanceof RegistryError) return fail(400, { error: error.message });
			throw error;
		}
	}
} satisfies Actions;
