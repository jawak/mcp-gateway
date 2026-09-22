import { desc, eq } from 'drizzle-orm';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	getSnapshot,
	RegistryError,
	setUpstreamEnabled,
	updateUpstream
} from '$lib/server/registry';
import { parseArgsLine, parseEnvLines, rowsToRefs } from '$lib/server/registry/env-form';

import { listSecrets, putSecret, secretExists } from '$lib/server/governance/secrets';
import { testUpstream } from '$lib/server/governance/upstream-test';
import { getDb } from '$lib/server/db/index';
import { upstreamHealth } from '$lib/server/db/schema';

export const load = (async ({ params }) => {
	const snapshot = getSnapshot();
	const record = snapshot.upstreamsBySlug.get(params.slug);
	if (!record) throw error(404, 'Upstream not found');

	// which profiles expose this upstream, and what they hide
	const scopes = [...snapshot.profilesById.values()]
		.map((profile) => {
			const link = profile.links.find((entry) => entry.upstream.slug === record.slug);
			return link
				? { id: profile.id, name: profile.name, allow: link.allowGlobs, deny: link.denyGlobs }
				: null;
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== null);

	return {
		record,
		scopes,
		secrets: listSecrets(),
		// which references are currently unresolvable: the reason for `unconfigured`
		problems: describeRefs(
			record.envRefs ?? {},
			(record.connection as { authRef?: string } | null)?.authRef
		),
		history: healthHistory(record.id)
	};
}) satisfies PageServerLoad;

function describeRefs(envRefs: Record<string, string>, authRef?: string): string[] {
	const problems: string[] = [];
	for (const [name, ref] of Object.entries(envRefs)) {
		if (ref.startsWith('secret:')) {
			if (!secretExists(ref))
				problems.push(`${name}: secret "${ref.slice('secret:'.length)}" no longer exists`);
			continue;
		}
		const hostVar = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(ref);
		if (hostVar && !process.env[hostVar[1] as string]) {
			problems.push(`${name}: host variable ${hostVar[1]} is not set on this gateway`);
		}
	}
	if (authRef?.startsWith('secret:') && !secretExists(authRef)) {
		problems.push(`Authorization: secret "${authRef.slice('secret:'.length)}" no longer exists`);
	}
	return problems;
}

function healthHistory(
	upstreamId: string
): Array<{ status: string; latencyMs: number | null; error: string | null; checkedAt: string }> {
	return getDb()
		.select()
		.from(upstreamHealth)
		.where(eq(upstreamHealth.upstreamId, upstreamId))
		.orderBy(desc(upstreamHealth.checkedAt))
		.limit(20)
		.all()
		.map((row) => ({
			status: row.status,
			latencyMs: row.latencyMs,
			error: row.error,
			checkedAt: row.checkedAt
		}));
}

export const actions = {
	update: async ({ params, request, locals, getClientAddress }) => {
		const data = await request.formData();
		const record = getSnapshot().upstreamsBySlug.get(params.slug);
		if (!record) throw error(404, 'Upstream not found');
		const values = Object.fromEntries(data) as Record<string, string>;
		const fieldErrors: Record<string, string> = {};

		let envRefs = record.envRefs ?? {};
		if (typeof values.env === 'string') {
			const parsed = parseEnvLines(values.env);
			if (parsed.errors.length > 0) fieldErrors.env = parsed.errors[0] as string;
			else {
				try {
					envRefs = rowsToRefs(parsed.rows);
				} catch (caught) {
					if (caught instanceof RegistryError) fieldErrors.env = caught.message;
					else throw caught;
				}
			}
		}

		// optional inline secret rotation: the reference stays the same, so no
		// upstream edits are needed when a token is replaced
		const secretName = (values.secretName ?? '').trim();
		const secretValue = values.secretValue ?? '';
		if (secretName && !secretValue)
			fieldErrors.secretValue = 'Enter the new value for this secret.';

		const connection = { ...(record.connection as Record<string, unknown>) };
		if (record.transport === 'stdio') {
			if (values.command !== undefined) connection.command = values.command.trim();
			if (values.args !== undefined) {
				try {
					connection.args = parseArgsLine(values.args);
				} catch (error) {
					fieldErrors.args = (error as Error).message;
				}
			}
			if (values.cwd !== undefined && values.cwd.trim()) connection.cwd = values.cwd.trim();
		} else if (values.url !== undefined) {
			connection.url = values.url.trim();
		}

		if (Object.keys(fieldErrors).length > 0) return fail(400, { fieldErrors, values });

		const actor = { actorId: locals.user?.id ?? null, ip: getClientAddress() };
		if (secretName && secretValue) putSecret(secretName, secretValue, actor);

		try {
			updateUpstream(
				record.id,
				{
					name: values.name?.trim() || record.name,
					connection: connection as never,
					envRefs,
					pin: values.pin === 'lazy' ? 'lazy' : 'pinned',
					...(values.timeoutMs
						? { timeoutMs: clampTimeout(Number.parseInt(values.timeoutMs, 10) || record.timeoutMs) }
						: {})
				},
				actor
			);
		} catch (caught) {
			if (caught instanceof RegistryError) return fail(400, { error: caught.message, values });
			throw caught;
		}

		// a config change can make a previously-working upstream dead, so re-probe
		await testUpstream(params.slug, actor);
		throw redirect(303, `/admin/upstreams/${params.slug}?saved=1`);
	},

	toggle: async ({ params, request, locals, getClientAddress }) => {
		const data = await request.formData();
		const record = getSnapshot().upstreamsBySlug.get(params.slug);
		if (!record) throw error(404, 'Upstream not found');
		setUpstreamEnabled(record.id, data.get('enabled') === 'true', {
			actorId: locals.user?.id ?? null,
			ip: getClientAddress()
		});
		throw redirect(303, `/admin/upstreams/${params.slug}`);
	},

	check: async ({ params, locals, getClientAddress }) => {
		const result = await testUpstream(params.slug, {
			actorId: locals.user?.id ?? null,
			ip: getClientAddress()
		});
		throw redirect(
			303,
			`/admin/upstreams/${params.slug}?checked=1${result.ok ? '' : `&error=${encodeURIComponent(result.message ?? 'failed')}`}`
		);
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const record = getSnapshot().upstreamsBySlug.get(params.slug);
		if (!record) throw error(404, 'Upstream not found');
		const { deleteUpstream } = await import('$lib/server/registry');
		try {
			deleteUpstream(record.id, { actorId: locals.user?.id ?? null, ip: getClientAddress() });
		} catch (caught) {
			if (caught instanceof RegistryError) return fail(400, { error: caught.message });
			throw caught;
		}
		throw redirect(303, '/admin/upstreams');
	}
} satisfies Actions;

function clampTimeout(value: number): number {
	return Math.min(600_000, Math.max(1_000, value));
}
