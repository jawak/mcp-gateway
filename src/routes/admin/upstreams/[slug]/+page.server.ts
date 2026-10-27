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
import { displayStatus } from '$lib/server/upstream/health';
import { resolveAuthMode } from '$lib/server/upstream/types';
import {
	clearOAuthConfig,
	getOAuthConfig,
	oauthTokenName,
	readTokenSecret,
	setOAuthStatus,
	type OAuthConfig
} from '$lib/server/upstream/oauth/store';
import { buildOAuthView } from '$lib/server/upstream/oauth/view';
import {
	createOAuthProvider,
	OAuthAuthorizationRequiredError,
	OAuthStateError,
	UnsupportedAuthMethodError
} from '$lib/server/upstream/oauth/provider';
import { withUpstreamLock } from '$lib/server/upstream/oauth/fetch';
import { createSsrfSafeFetch } from '$lib/server/security/ssrf';
import { redactString } from '$lib/server/security/redact';
import { recordAudit } from '$lib/server/observability/audit';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/index';
import { upstreamHealth, users } from '$lib/server/db/schema';

export const load = (async ({ params, locals }) => {
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

	const history = healthHistory(record.id);
	const latest = history[0]
		? { status: history[0].status, checkedAt: history[0].checkedAt, error: history[0].error }
		: undefined;
	const effective = displayStatus(record.status, latest);
	const authMode = resolveAuthMode(record.connection, record.headersRef);
	const canManage = locals?.user?.role === 'admin';
	const oauthConfig = authMode === 'oauth' ? getOAuthConfig(record.id) : undefined;
	const oauthSecretNames = new Set([
		oauthTokenName(record.slug, 'access'),
		oauthTokenName(record.slug, 'refresh'),
		oauthTokenName(record.slug, 'client_secret')
	]);

	return {
		record,
		scopes,
		secrets:
			authMode === 'oauth'
				? listSecrets().filter((secret) => !oauthSecretNames.has(secret.name))
				: listSecrets(),
		// which references are currently unresolvable: the reason for `unconfigured`
		problems: describeRefs(
			record.envRefs ?? {},
			(record.connection as { authRef?: string } | null)?.authRef
		),
		authMode,
		oauth:
			authMode === 'oauth'
				? buildOAuthView({
						config: oauthConfig,
						connectedByEmail: oauthConnectedByEmail(oauthConfig?.connectedBy),
						canManage,
						redirectUri: `${getConfig().publicUrl.origin}/oauth/callback`
					})
				: null,
		effectiveStatus: record.enabled ? effective.status : 'down',
		effectiveError: effective.error ?? record.lastError ?? null,
		history
	};
}) satisfies PageServerLoad;

function oauthConnectedByEmail(userId: string | null | undefined): string | null {
	if (!userId) return null;
	const row = getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
	return row?.email ?? null;
}

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
		.orderBy(desc(upstreamHealth.checkedAt), desc(upstreamHealth.id))
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
	},

	oauthStart: async ({ params, locals, getClientAddress }) => {
		const record = getSnapshot().upstreamsBySlug.get(params.slug);
		if (!record) throw error(404, 'Upstream not found');

		const connection = record.connection as { url?: string } | null;
		if (resolveAuthMode(record.connection, record.headersRef) !== 'oauth' || !connection?.url) {
			throw error(400, 'OAuth is not enabled for this upstream');
		}

		const actor = { actorId: locals.user?.id ?? null, ip: getClientAddress() };
		const oauthConfig = getOAuthConfig(record.id);

		if (hasUsableAccessToken(oauthConfig)) {
			throw redirect(303, detailPath(record.slug, 'connected=1'));
		}

		recordAudit({
			actorType: 'user',
			actorId: actor.actorId,
			action: 'oauth.connect.start',
			targetType: 'upstream',
			targetId: record.id,
			ip: actor.ip,
			meta: { slug: record.slug }
		});

		const provider = createOAuthProvider({
			upstreamId: record.id,
			slug: record.slug,
			serverUrl: connection.url,
			publicUrl: getConfig().publicUrl,
			scopes: oauthConfig?.scopes?.trim() ?? '',
			createdBy: locals.user?.id ?? null
		});

		let result: Awaited<ReturnType<typeof auth>>;
		try {
			result = await withUpstreamLock(record.id, () =>
				auth(provider, {
					serverUrl: connection.url as string,
					fetchFn: createSsrfSafeFetch()
				})
			);
		} catch (caught) {
			if (caught instanceof OAuthAuthorizationRequiredError) {
				const authorizationUrl = safeAuthorizationUrl(caught.authorizationUrl);
				if (!authorizationUrl) {
					oauthFailure(record, actor, 'invalid_authorization_url', caught);
				}
				setOAuthStatus(record.id, 'authorizing');
				throw redirect(303, authorizationUrl);
			}
			oauthFailure(record, actor, safeOAuthErrorCode(caught), caught);
		}

		if (result === 'AUTHORIZED') {
			recordAudit({
				actorType: 'user',
				actorId: actor.actorId,
				action: 'oauth.connect.success',
				targetType: 'upstream',
				targetId: record.id,
				ip: actor.ip,
				meta: { slug: record.slug }
			});
			throw redirect(303, detailPath(record.slug, 'connected=1'));
		}

		oauthFailure(record, actor, 'authorization_required', new Error('authorization required'));
	},

	oauthDisconnect: async ({ params, locals, getClientAddress }) => {
		const record = getSnapshot().upstreamsBySlug.get(params.slug);
		if (!record) throw error(404, 'Upstream not found');

		clearOAuthConfig(record.id);
		recordAudit({
			actorType: 'user',
			actorId: locals.user?.id ?? null,
			action: 'oauth.disconnect',
			targetType: 'upstream',
			targetId: record.id,
			ip: getClientAddress(),
			meta: { slug: record.slug }
		});
		throw redirect(303, detailPath(record.slug, 'disconnected=1'));
	}
} satisfies Actions;

const MAX_LAST_ERROR = 500;
const SAFE_OAUTH_CODE = /^[a-z][a-z0-9_]{0,40}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function detailPath(slug: string, query: string): string {
	return `/admin/upstreams/${encodeURIComponent(slug)}?${query}`;
}

function hasUsableAccessToken(config: OAuthConfig | undefined): boolean {
	if (!config?.accessTokenRef) return false;
	if (!readTokenSecret(config.accessTokenRef)) return false;
	if (!config.expiresAt) return true;
	const expiresAt = Date.parse(config.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt > Date.now();
}

function safeAuthorizationUrl(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.username || url.password) return null;
	if (url.protocol === 'https:') return url.toString();
	if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.toString();
	return null;
}

function safeOAuthErrorCode(caught: unknown): string {
	if (caught instanceof OAuthStateError && SAFE_OAUTH_CODE.test(caught.code)) return caught.code;
	if (caught instanceof UnsupportedAuthMethodError) return 'unsupported_auth_method';
	return 'oauth_failed';
}

function oauthFailure(
	record: { id: string; slug: string },
	actor: { actorId: string | null; ip: string | null },
	code: string,
	caught: unknown
): never {
	const safeCode = SAFE_OAUTH_CODE.test(code) ? code : 'oauth_failed';
	const message = caught instanceof Error ? caught.message : String(caught);
	const lastError = redactString(message).trim().slice(0, MAX_LAST_ERROR) || 'OAuth connect failed';

	setOAuthStatus(record.id, 'error', { lastError });
	recordAudit({
		actorType: 'user',
		actorId: actor.actorId,
		action: 'oauth.connect.failure',
		targetType: 'upstream',
		targetId: record.id,
		ip: actor.ip,
		meta: { code: safeCode }
	});
	throw redirect(303, detailPath(record.slug, `oauthError=${encodeURIComponent(safeCode)}`));
}

function clampTimeout(value: number): number {
	return Math.min(600_000, Math.max(1_000, value));
}
