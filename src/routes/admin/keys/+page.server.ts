import type { PageServerLoad } from './$types';
import { listApiKeys } from '$lib/server/governance/apikey';
import { getSnapshot } from '$lib/server/registry';

export const load = (() => {
	const profiles = getSnapshot().profilesById;
	const now = Date.now();
	return {
		rows: listApiKeys().map((key) => ({
			id: key.id,
			name: key.name,
			prefix: key.keyPrefix,
			tail: key.keyTail4,
			status: key.status,
			profileName: profiles.get(key.profileId)?.name ?? '(missing profile)',
			profileMissing: !profiles.has(key.profileId),
			expiresAt: key.expiresAt,
			expired: key.expiresAt !== null && new Date(key.expiresAt).getTime() < now,
			lastUsedAt: key.lastUsedAt,
			createdAt: key.createdAt
		}))
	};
}) satisfies PageServerLoad;
