import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTemplate, listTemplates, planInstall } from '$lib/server/templates';
import { createUpstream, RegistryError } from '$lib/server/registry';
import { putSecret } from '$lib/server/governance/secrets';
import { testUpstream } from '$lib/server/governance/upstream-test';
import type { HttpConnection, StdioConnection } from '$lib/server/upstream/types';

export const load = (() => ({
	templates: listTemplates().map((template) => ({
		id: template.id,
		name: template.name,
		description: template.description,
		transport: template.transport,
		tags: template.tags,
		docsUrl: template.docsUrl,
		fields: template.fields
	})),
	installed: [] as string[]
})) satisfies PageServerLoad;

/**
 * Install a template.
 *
 * Templates are documentation with structure, not a package manager: nothing is
 * downloaded or executed here, and every credential entered becomes a sealed secret
 * referenced as `secret:<slug>__<env>` — so the exported manifest stays free of
 * tokens (BR-09) whichever path an operator took.
 */
export const actions = {
	install: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const templateId = String(data.get('template') ?? '');
		const template = getTemplate(templateId);
		// every failure path returns the same shape so the page's `form` type stays narrow
		const failure = (error: string, slug = '', answers: Record<string, string> = {}) =>
			fail(400, { error, openId: templateId, slug, answers });

		if (!template) return failure('Unknown template.');

		const slug = (String(data.get('slug') ?? '').trim() || templateId).toLowerCase();
		const answers: Record<string, string> = {};
		for (const field of template.fields)
			answers[field.env] = String(data.get(`field:${field.env}`) ?? '').trim();

		const actor = { actorId: locals.user?.id ?? null, ip: getClientAddress() };
		// One implementation for both template paths; this route used to keep its own
		// copy of the loop, which is how the two drifted apart.
		const { plan, secrets, missing } = planInstall(template, answers, slug);
		if (missing.length > 0) return failure(`Missing: ${missing.join(', ')}`, slug, answers);

		// sealed before the upstream is created, so a reference can never point at a
		// secret that does not exist
		for (const secret of secrets) {
			try {
				putSecret(secret.name, secret.value, actor);
			} catch (error) {
				return failure((error as Error).message, slug, answers);
			}
		}

		// installed first, then probed: the probe decides whether it is enabled,
		// and it needs the row to exist
		let createdId: string;
		try {
			const created = createUpstream(
				{
					slug: plan.slug,
					name: plan.name,
					transport: plan.transport,
					connection: plan.connection as StdioConnection | HttpConnection,
					envRefs: plan.envRefs,
					...(plan.headersRef ? { headersRef: plan.headersRef } : {}),
					pin: 'pinned',
					enabled: true
				},
				actor
			);
			createdId = created.id;
		} catch (error) {
			if (error instanceof RegistryError)
				return fail(400, { error: error.message, openId: templateId, slug, answers });
			throw error;
		}

		const test = await testUpstream(slug, actor);
		if (!test.ok) {
			const { setUpstreamEnabled } = await import('$lib/server/registry');
			setUpstreamEnabled(createdId, false, actor);
			throw redirect(
				303,
				`/admin/upstreams/${slug}?created=1&healthy=0&error=${encodeURIComponent(test.message ?? 'unreachable')}`
			);
		}
		throw redirect(303, `/admin/upstreams/${slug}?created=1&healthy=1&tools=${test.tools ?? 0}`);
	}
} satisfies Actions;
