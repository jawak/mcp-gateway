/**
 * Public OAuth redirect endpoint (datadog-mcp-oauth todo 14).
 *
 * OAuth callbacks are unauthenticated by design: the authorization server sends
 * the browser here with no dashboard session. `state` is the CSRF token — it is
 * looked up as a single-use pending row, so an unknown, expired, or replayed
 * value gets a generic 400 and never reaches the token endpoint.
 *
 * The redirect target is derived only from the pending row's upstream slug.
 * The query string is never used as a navigation target, and the code, state,
 * and any token value stay out of the URL, the audit trail, and `last_error`.
 */
import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { getConfig } from '$lib/server/config';
import { recordAudit } from '$lib/server/observability/audit';
import { redactString } from '$lib/server/security/redact';
import { createSsrfSafeFetch } from '$lib/server/security/ssrf';
import { getUpstreamById } from '$lib/server/registry';
import { resolveAuthMode, type UpstreamRecord } from '$lib/server/upstream/types';
import {
	createOAuthProvider,
	OAuthStateError,
	UnsupportedAuthMethodError
} from '$lib/server/upstream/oauth/provider';
import { withUpstreamLock } from '$lib/server/upstream/oauth/fetch';
import {
	consumePending,
	getPending,
	setOAuthStatus,
	type PendingRow
} from '$lib/server/upstream/oauth/store';
import { nowIso } from '$lib/shared/time';

const MAX_LAST_ERROR = 500;
const SAFE_OAUTH_CODE = /^[a-z][a-z0-9_]{0,40}$/;

export const GET = (async ({ url, locals }) => {
	const state = url.searchParams.get('state');
	const code = url.searchParams.get('code');
	const oauthError = url.searchParams.get('error');
	const errorDescription = url.searchParams.get('error_description');

	const pending = state ? getPending(state) : undefined;
	if (!pending || pending.expiresAt <= nowIso()) {
		// delete an expired row so an abandoned flow cannot linger; an unknown
		// state has nothing to delete and gets the same generic answer
		if (state) consumePending(state);
		throw error(400, 'Invalid or expired OAuth callback');
	}

	// A dashboard session may be present on the same browser. It must match the
	// admin who started the flow; otherwise this is a cross-session CSRF callback
	// and the pending row is left untouched for the real owner.
	if (locals.user && pending.createdBy !== locals.user.id) {
		throw error(403, 'OAuth callback does not match the signed-in session');
	}

	const record = getUpstreamById(pending.upstreamId);
	if (!record || !isCallableOAuthUpstream(record)) {
		consumePending(pending.state);
		throw error(400, 'Invalid or expired OAuth callback');
	}

	if (oauthError) {
		consumePending(pending.state);
		const safeError = safeOAuthCode(oauthError);
		failCallback(
			record,
			pending,
			safeError,
			redactDetail(errorDescription ?? oauthError, [code, state])
		);
		throw redirect(303, detailPath(record.slug, `oauthError=${encodeURIComponent(safeError)}`));
	}

	if (!code) {
		consumePending(pending.state);
		failCallback(record, pending, 'invalid_request', 'Missing authorization code');
		throw redirect(303, detailPath(record.slug, 'oauthError=invalid_request'));
	}

	const connection = record.connection as { url: string };
	const provider = createOAuthProvider({
		upstreamId: record.id,
		slug: record.slug,
		serverUrl: connection.url,
		publicUrl: getConfig().publicUrl,
		scopes: '',
		createdBy: pending.createdBy ?? null
	});

	// Serialize per upstream so two concurrent calls for the same state cannot
	// both reach the token endpoint. The winner re-checks the row, exchanges, and
	// consumes; the loser sees it gone and gets the same 400 as a replay.
	const outcome = await withUpstreamLock(pending.upstreamId, async () => {
		if (!getPending(pending.state)) return 'replayed' as const;

		let failure: { code: string; detail: string } | undefined;
		try {
			const result = await auth(provider, {
				serverUrl: connection.url,
				authorizationCode: code,
				fetchFn: createSsrfSafeFetch()
			});
			if (result !== 'AUTHORIZED') {
				failure = {
					code: 'authorization_required',
					detail: 'Authorization was not completed'
				};
			}
		} catch (caught) {
			failure = {
				code: safeOAuthErrorCode(caught),
				detail: redactDetail(errorMessage(caught), [code, state])
			};
		}

		// every terminal outcome consumes the row exactly once, so the same state
		// can never exchange a second code
		consumePending(pending.state);
		return failure ?? null;
	});

	if (outcome === 'replayed') throw error(400, 'Invalid or expired OAuth callback');
	const failure = outcome;

	if (failure) {
		failCallback(record, pending, failure.code, failure.detail);
		throw redirect(
			303,
			detailPath(record.slug, `oauthError=${encodeURIComponent(failure.code)}`)
		);
	}

	setOAuthStatus(record.id, 'connected', { connectedBy: pending.createdBy ?? null });
	recordAudit({
		actorType: 'system',
		actorId: null,
		action: 'oauth.connect.success',
		targetType: 'upstream',
		targetId: record.id,
		meta: { slug: record.slug, createdBy: pending.createdBy ?? null }
	});
	throw redirect(303, detailPath(record.slug, 'connected=1'));
}) satisfies RequestHandler;

function isCallableOAuthUpstream(record: UpstreamRecord): boolean {
	const connection = record.connection as { url?: unknown } | null;
	return (
		record.transport === 'http' &&
		resolveAuthMode(record.connection, record.headersRef) === 'oauth' &&
		typeof connection?.url === 'string' &&
		connection.url.length > 0
	);
}

function detailPath(slug: string, query: string): string {
	return `/admin/upstreams/${encodeURIComponent(slug)}?${query}`;
}

function failCallback(record: UpstreamRecord, pending: PendingRow, code: string, detail: string): void {
	setOAuthStatus(record.id, 'error', { lastError: detail });
	recordAudit({
		actorType: 'system',
		actorId: null,
		action: 'oauth.connect.failure',
		targetType: 'upstream',
		targetId: record.id,
		meta: { slug: record.slug, createdBy: pending.createdBy ?? null, code }
	});
}

function safeOAuthCode(value: string | null | undefined): string {
	return value && SAFE_OAUTH_CODE.test(value) ? value : 'oauth_failed';
}

function safeOAuthErrorCode(caught: unknown): string {
	if (caught instanceof OAuthStateError && SAFE_OAUTH_CODE.test(caught.code)) return caught.code;
	if (caught instanceof UnsupportedAuthMethodError) return 'unsupported_auth_method';
	return 'oauth_failed';
}

function errorMessage(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Remove the exact code/state strings this callback knows about before applying
 * the generic credential patterns. This keeps `last_error` safe even if a
 * third-party error body echoes the request parameters.
 */
function redactDetail(text: string, secrets: Array<string | null | undefined>): string {
	let value = text;
	for (const secret of secrets) {
		if (secret) value = value.split(secret).join('[redacted]');
	}
	return redactString(value).trim().slice(0, MAX_LAST_ERROR) || 'OAuth callback failed';
}
