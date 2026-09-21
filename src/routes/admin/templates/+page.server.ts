import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTemplate, listTemplates } from '$lib/server/templates';
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

		const missing = template.fields
			.filter((field) => field.required && !answers[field.env])
			.map((field) => field.label);
		if (missing.length > 0) {
			return fail(400, {
				error: `Missing: ${missing.join(', ')}`,
				openId: templateId,
				slug,
				answers
			});
		}

		const actor = { actorId: locals.user?.id ?? null, ip: getClientAddress() };
		const envRefs: Record<string, string> = {};
		const args = [...template.args];
		for (const field of template.fields) {
			const value = answers[field.env];
			if (!value) continue;
			if (field.secret) {
				const secretName = `${slug}__${field.env.toLowerCase()}`
					.toLowerCase()
					.replace(/[^a-z0-9_-]/g, '-');
				try {
					putSecret(secretName, value, actor);
				} catch (error) {
					return failure((error as Error).message, slug, answers);
				}
				envRefs[field.env] = `secret:${secretName}`;
			} else {
				// non-secret values are passed as arguments, exactly as the CLI expects them
				envRefs[field.env] = `\${${field.env}}`;
				args.push(value);
			}
		}

		const connection: StdioConnection | HttpConnection =
			template.transport === 'stdio'
				? { command: template.command ?? 'npx', args }
				: { url: template.url as string, authStyle: template.authStyle };

		// installed first, then probed: the probe decides whether it is enabled,
		// and it needs the row to exist
		let createdId: string;
		try {
			const created = createUpstream(
				{
					slug,
					name: template.name,
					transport: template.transport,
					connection,
					envRefs,
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
