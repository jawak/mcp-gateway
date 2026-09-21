import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	createUpstream,
	RegistryError,
	assertValidSlug,
	setUpstreamEnabled
} from '$lib/server/registry';
import { normaliseRef, parseEnvLines, rowsToRefs } from '$lib/server/registry/env-form';
import { putSecret, listSecrets } from '$lib/server/governance/secrets';
import { testUpstream } from '$lib/server/governance/upstream-test';
import { getUpstreamPool } from '$lib/server/upstream/pool';
import { getTemplate, listTemplates, planInstall } from '$lib/server/templates';
import type { HttpConnection, StdioConnection } from '$lib/server/upstream/types';

export const load = (() => ({
	secrets: listSecrets(),
	templates: listTemplates().map((template) => ({
		id: template.id,
		name: template.name,
		fields: template.fields
	}))
})) satisfies PageServerLoad;

/**
 * Create an upstream, by hand or from a template.
 *
 * The handshake runs as part of creation and a failure does not discard the
 * record: it is stored disabled with the error shown. That beats losing what the
 * operator typed because `npx` needed a minute to warm up, while still never
 * exposing broken tools in a catalog.
 */
export const actions = {
	create: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const values = Object.fromEntries(data) as Record<string, string>;
		const actor = { actorId: locals.user?.id ?? null, ip: getClientAddress() };

		const slug = (values.slug ?? '').trim();
		const name = (values.name ?? '').trim();
		const transport = values.transport === 'http' ? 'http' : 'stdio';
		const fieldErrors: Record<string, string> = {};

		try {
			assertValidSlug(slug);
		} catch (error) {
			fieldErrors.slug = (error as Error).message;
		}
		if (!name) fieldErrors.name = 'A display name is required.';

		let connection: StdioConnection | HttpConnection;
		if (transport === 'stdio') {
			const command = (values.command ?? '').trim();
			if (!command) fieldErrors.command = 'Command is required, e.g. npx.';
			const stdio: StdioConnection = {
				command,
				args: (values.args ?? '')
					.split(' ')
					.map((part) => part.trim())
					.filter((part) => part !== '')
			};
			if ((values.cwd ?? '').trim()) stdio.cwd = values.cwd!.trim();
			connection = stdio;
		} else {
			const url = (values.url ?? '').trim();
			if (!isHttpUrl(url))
				fieldErrors.url = 'Enter an https:// URL (http:// is only allowed for localhost).';
			const style = values.authStyle ?? 'none';
			const http: HttpConnection = {
				url,
				authStyle: style === 'bearer' || style === 'header' ? style : 'none'
			};
			if (http.authStyle === 'header') http.authName = (values.authName || 'authorization').trim();
			const authRef = (values.authRef ?? '').trim();
			if (authRef) {
				try {
					http.authRef = normaliseRef('Authorization', authRef, { allowLiteral: false });
				} catch (error) {
					if (error instanceof RegistryError) fieldErrors.authRef = error.message;
					else throw error;
				}
			}
			connection = http;
		}

		const parsed = parseEnvLines(values.env ?? '');
		if (parsed.errors.length > 0) fieldErrors.env = parsed.errors[0] as string;
		let envRefs: Record<string, string> = {};
		if (!fieldErrors.env) {
			try {
				envRefs = rowsToRefs(parsed.rows);
			} catch (error) {
				if (error instanceof RegistryError) fieldErrors.env = error.message;
				else throw error;
			}
		}

		const secretName = (values.secretName ?? '').trim();
		const secretValue = values.secretValue ?? '';
		if (secretName && !secretValue) fieldErrors.secretValue = 'Enter a value for the new secret.';
		if (secretValue && !secretName)
			fieldErrors.secretName = 'Name the secret this value belongs to.';

		if (Object.keys(fieldErrors).length > 0) return fail(400, { values, fieldErrors });

		if (secretName && secretValue) putSecret(secretName, secretValue, actor);

		try {
			const created = createUpstream(
				{
					slug,
					name,
					transport,
					connection,
					envRefs,
					pin: values.pin === 'lazy' ? 'lazy' : 'pinned',
					timeoutMs: clampTimeout(Number.parseInt(values.timeoutMs ?? '60000', 10) || 60_000),
					enabled: true
				},
				actor
			);
			await finish(slug, created.id, actor);
		} catch (error) {
			if (error instanceof RegistryError) return fail(400, { error: error.message, values });
			throw error;
		}
	},

	/** Install from a template: secrets are created and referenced, never inlined. */
	fromTemplate: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const templateId = String(data.get('template') ?? '');
		const template = getTemplate(templateId);
		if (!template) return fail(400, { error: 'Unknown template.' });

		const slug = (String(data.get('slug') ?? '') || templateId).trim();
		const answers: Record<string, string> = {};
		for (const field of template.fields)
			answers[field.env] = String(data.get(`field:${field.env}`) ?? '');

		const actor = { actorId: locals.user?.id ?? null, ip: getClientAddress() };
		let planned;
		try {
			planned = planInstall(template, answers, slug);
		} catch (error) {
			return fail(400, { error: (error as Error).message });
		}
		if (planned.missing.length > 0) {
			return fail(400, { error: `Missing required values: ${planned.missing.join(', ')}` });
		}

		for (const secret of planned.secrets) putSecret(secret.name, secret.value, actor);

		try {
			const created = createUpstream(
				{
					slug: planned.plan.slug,
					name: planned.plan.name,
					transport: planned.plan.transport,
					connection: planned.plan.connection as StdioConnection | HttpConnection,
					envRefs: planned.plan.envRefs,
					pin: 'pinned',
					enabled: true
				},
				actor
			);
			await finish(slug, created.id, actor);
		} catch (error) {
			if (error instanceof RegistryError) return fail(400, { error: error.message });
			throw error;
		}
	}
} satisfies Actions;

/**
 * Probe the new upstream and land on its detail page. A failed probe disables the
 * upstream, because an unreachable upstream in the catalogue means the model will
 * try to use it and fail in a way the operator cannot see.
 */
async function finish(
	slug: string,
	id: string,
	actor: { actorId: string | null; ip: string | null }
): Promise<never> {
	const test = await testUpstream(slug, getUpstreamPool(), actor);
	if (!test.ok) {
		setUpstreamEnabled(id, false, actor);
		throw redirect(
			303,
			`/admin/upstreams/${slug}?created=1&healthy=0&error=${encodeURIComponent(test.message ?? 'handshake failed')}`
		);
	}
	throw redirect(303, `/admin/upstreams/${slug}?created=1&healthy=1`);
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol === 'https:') return true;
		return (
			url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
		);
	} catch {
		return false;
	}
}

function clampTimeout(value: number): number {
	return Math.min(600_000, Math.max(1_000, value));
}
