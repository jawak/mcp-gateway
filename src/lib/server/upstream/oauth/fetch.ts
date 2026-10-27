/**
 * Single-flight OAuth fetch coordinator (datadog-mcp-oauth todo 7).
 *
 * The transport already stamps `Authorization: Bearer <tokens().access_token>`
 * on every request. When that token is stale the server answers 401; this module
 * then refreshes exactly once per upstream and retries the original request
 * exactly once. Concurrent 401s collapse onto one token request: the first
 * holder refreshes under the mutex, the rest observe the changed access token
 * and retry with it without touching `/token`.
 *
 * Every network call goes through the caller-supplied `baseFetch` (todo 8 passes
 * the SSRF-safe fetch), including the SDK's refresh request. Nothing here logs a
 * token; terminal refresh failures are reported by returning the original 401.
 */
import {
	refreshAuthorization,
	type OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
	InvalidClientError,
	InvalidGrantError,
	UnauthorizedClientError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createSsrfSafeFetch } from '../../security/ssrf.ts';
import type { OAuthProvider } from './provider.ts';

export type OAuthFetchOptions = {
	upstreamId: string;
	/** Must be the SSRF-safe fetch; used for the MCP request and the token refresh. */
	baseFetch: FetchLike;
	provider: OAuthProvider;
	/** Called after a successful refresh; receives no token material. */
	onRefreshed?: () => void;
};

type RefreshOutcome =
	| { ok: true; tokens: OAuthTokens }
	| { ok: false; reason: 'invalid_grant' | 'invalid_client' | 'unavailable' | 'error' };

// ---------------------------------------------------------------------------
// Per-upstream in-process mutex
// ---------------------------------------------------------------------------

const lockTails = new Map<string, Promise<unknown>>();
const providerLockIds = new WeakMap<OAuthProvider, string>();
const providerUpstreamIds = new WeakMap<OAuthProvider, string>();
let providerLockSequence = 0;

/**
 * Fallback when a caller (e.g. a test) does not supply a fetch. It is still the
 * SSRF-safe fetch, never the global one.
 */
const DEFAULT_REFRESH_FETCH = createSsrfSafeFetch();

/**
 * Serialize work per upstream inside this process. The product is single-node
 * (docs/nfr-report.md), so an in-process tail chain is the correct lock, not a
 * database advisory lock.
 */
export function withUpstreamLock<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = lockTails.get(key) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(task);
	lockTails.set(key, run);
	void run
		.finally(() => {
			if (lockTails.get(key) === run) lockTails.delete(key);
		})
		.catch(() => undefined);
	return run;
}

/** Stable lock identity for callers that cannot supply an upstream id. */
function providerLockId(provider: OAuthProvider): string {
	const existing = providerLockIds.get(provider);
	if (existing) return existing;
	providerLockSequence += 1;
	const id = `provider:${providerLockSequence}`;
	providerLockIds.set(provider, id);
	return id;
}

/** Raw upstream id when known; a provider-scoped id otherwise. Never prefixed twice. */
function lockKeyFor(provider: OAuthProvider, upstreamId?: string): string {
	if (upstreamId) return upstreamId;
	const registered = providerUpstreamIds.get(provider);
	if (registered) return registered;
	const exposed = (provider as { upstreamId?: unknown }).upstreamId;
	if (typeof exposed === 'string' && exposed.length > 0) return exposed;
	return providerLockId(provider);
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function bearerFrom(init: RequestInit | undefined): string | undefined {
	const value = new Headers(init?.headers).get('authorization');
	const match = /^Bearer\s+(.+)$/i.exec(value ?? '');
	return match?.[1];
}

function requestWithBearer(
	input: string | URL,
	init: RequestInit | undefined,
	token: string | undefined,
	override: boolean
): Request {
	const headers = new Headers(init?.headers);
	if (token && (override || !headers.has('authorization'))) {
		headers.set('authorization', `Bearer ${token}`);
	}
	return new Request(input, { ...init, headers });
}

/** Dispatch a prepared Request without disturbing its body (each attempt owns a clone). */
function sendRequest(baseFetch: FetchLike, request: Request): Promise<Response> {
	const init: RequestInit = {
		method: request.method,
		headers: request.headers,
		signal: request.signal,
		redirect: request.redirect
	};
	if (request.body) init.body = request.body;
	return baseFetch(request.url, init);
}

/** Overwrite the Authorization on the untouched original Request before a retry. */
function retryWithBearer(request: Request, token: string): Request {
	request.headers.set('authorization', `Bearer ${token}`);
	return request;
}

function resourceFor(discovery: OAuthDiscoveryState): URL | undefined {
	const configured = discovery.resourceMetadata?.resource;
	if (!configured) return undefined;
	try {
		return new URL(configured);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Refresh with the persisted discovery state and the stored refresh token.
 * Terminal OAuth errors invalidate only what they invalidate:
 *   - `invalid_grant`  → tokens are dead; keep client + discovery for reconnect
 *   - `invalid_client` → the client registration is dead; clear everything
 */
async function refreshTokens(provider: OAuthProvider, fetchFn: FetchLike): Promise<RefreshOutcome> {
	const discovery = provider.discoveryState();
	const tokens = provider.tokens();
	const clientInformation = provider.clientInformation();

	if (
		!discovery?.authorizationServerUrl ||
		!discovery.authorizationServerMetadata?.token_endpoint ||
		!tokens?.refresh_token ||
		!clientInformation
	) {
		return { ok: false, reason: 'unavailable' };
	}

	try {
		const refreshed = await refreshAuthorization(discovery.authorizationServerUrl, {
			metadata: discovery.authorizationServerMetadata,
			clientInformation,
			refreshToken: tokens.refresh_token,
			resource: resourceFor(discovery),
			addClientAuthentication: provider.addClientAuthentication,
			fetchFn
		});
		provider.saveTokens(refreshed);
		return { ok: true, tokens: refreshed };
	} catch (error) {
		if (error instanceof InvalidGrantError) {
			provider.invalidateCredentials('tokens');
			return { ok: false, reason: 'invalid_grant' };
		}
		if (error instanceof InvalidClientError || error instanceof UnauthorizedClientError) {
			provider.invalidateCredentials('all');
			return { ok: false, reason: 'invalid_client' };
		}
		return { ok: false, reason: 'error' };
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pre-connect freshness check.
 *
 * Returns true when a usable access token exists after the call. A token whose
 * expiry is unknown is considered usable (refresh is 401-driven, never invented
 * from a missing `expires_in`). A near-expiry token is refreshed under the same
 * per-upstream mutex used by 401 retries, so a connect and a concurrent first
 * request cannot both hit the token endpoint.
 */
export async function ensureFreshAccessToken(
	provider: OAuthProvider,
	skewMs = 60_000,
	baseFetch: FetchLike = DEFAULT_REFRESH_FETCH,
	upstreamId?: string
): Promise<boolean> {
	const key = lockKeyFor(provider, upstreamId);

	const initial = provider.tokens();
	if (!initial?.access_token) return false;
	if (initial.expires_in === undefined) return true;
	if (initial.expires_in * 1000 > skewMs) return true;
	if (!initial.refresh_token) return false;

	return withUpstreamLock(key, async () => {
		const current = provider.tokens();
		if (!current?.access_token) return false;
		if (current.expires_in === undefined) return true;
		if (current.expires_in * 1000 > skewMs) return true;
		if (!current.refresh_token) return false;

		const outcome = await refreshTokens(provider, baseFetch);
		return outcome.ok;
	});
}

/**
 * Fetch wrapper with a single 401 refresh + retry.
 *
 * Non-401 responses (including 500 and 403) are returned untouched. The refresh
 * and the retry each happen at most once; any terminal or transient refresh
 * failure returns the original 401 so the transport can surface
 * `authorization_required` instead of looping.
 */
export function createOAuthFetch(options: OAuthFetchOptions): FetchLike {
	const { upstreamId, baseFetch, provider, onRefreshed } = options;
	providerUpstreamIds.set(provider, upstreamId);

	return async (input, init) => {
		const current = provider.tokens();
		const headerToken = bearerFrom(init);
		const usedToken = headerToken ?? current?.access_token;
		const request = requestWithBearer(input, init, usedToken, headerToken === undefined);
		const first = await sendRequest(baseFetch, request.clone());

		if (first.status !== 401) return first;

		return withUpstreamLock(upstreamId, async (): Promise<Response> => {
			const latest = provider.tokens();

			if (latest?.access_token && latest.access_token !== usedToken) {
				void first.body?.cancel().catch(() => undefined);
				return sendRequest(baseFetch, retryWithBearer(request, latest.access_token));
			}

			if (!latest?.refresh_token) return first;

			const outcome = await refreshTokens(provider, baseFetch);
			if (!outcome.ok) return first;

			onRefreshed?.();
			const next = provider.tokens();
			if (!next?.access_token) return first;

			void first.body?.cancel().catch(() => undefined);
			return sendRequest(baseFetch, retryWithBearer(request, next.access_token));
		});
	};
}
