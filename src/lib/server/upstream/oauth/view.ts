/**
 * Display-only projection of an upstream's OAuth state (datadog-mcp-oauth todo 12).
 *
 * This is the only read path from `upstream_oauth` to a route. It deliberately
 * returns no token reference, seal material, verifier, client secret, or
 * discovery document: the page model is readable by every dashboard user who
 * can open the upstream, and a viewer must never receive an authorization
 * credential through a server-rendered payload.
 *
 * Keeping the projection pure means the "safe shape" can be pinned by a test
 * without a database or a Svelte render.
 */
import { redactString } from '../../security/redact.ts';

export const OAUTH_VIEW_STATUSES = ['disconnected', 'authorizing', 'connected', 'error'] as const;

export type OAuthViewStatus = (typeof OAUTH_VIEW_STATUSES)[number];

export const OAUTH_STATUS_LABEL: Record<OAuthViewStatus, string> = {
	disconnected: 'Disconnected',
	authorizing: 'Authorizing',
	connected: 'Connected',
	error: 'Error'
};

/** Only the non-secret columns a panel may render. */
export type OAuthConfigSnapshot = {
	status?: string | null;
	clientId?: string | null;
	scopes?: string | null;
	expiresAt?: string | null;
	connectedAt?: string | null;
	lastError?: string | null;
};

export type OAuthView = {
	status: OAuthViewStatus;
	clientId: string | null;
	scopes: string | null;
	expiresAt: string | null;
	connectedAt: string | null;
	connectedBy: string | null;
	lastError: string | null;
	redirectUri: string;
	canManage: boolean;
};

export type BuildOAuthViewInput = {
	/** Undefined when the upstream has no `upstream_oauth` row yet. */
	config: OAuthConfigSnapshot | undefined;
	connectedByEmail: string | null;
	canManage: boolean;
	redirectUri: string;
};

const MAX_CLIENT_ID = 16;
const MAX_LAST_ERROR = 500;

export function normalizeOAuthStatus(value: string | null | undefined): OAuthViewStatus {
	return OAUTH_VIEW_STATUSES.includes(value as OAuthViewStatus)
		? (value as OAuthViewStatus)
		: 'disconnected';
}

/**
 * Client ids are public but often long opaque strings. Show enough to recognise
 * a client while keeping the panel compact; the full id is still re-derivable
 * from the encrypted store if an operator ever needs it.
 */
export function truncateClientId(clientId: string | null | undefined): string | null {
	const value = clientId?.trim();
	if (!value) return null;
	if (value.length <= MAX_CLIENT_ID) return value;
	return `${value.slice(0, MAX_CLIENT_ID / 2)}…${value.slice(-4)}`;
}

/** Redact credential-shaped fragments before a third-party error reaches a page. */
export function redactLastError(lastError: string | null | undefined): string | null {
	const value = lastError?.trim();
	if (!value) return null;
	return redactString(value).slice(0, MAX_LAST_ERROR);
}

export function buildOAuthView(input: BuildOAuthViewInput): OAuthView {
	const { config, connectedByEmail, canManage, redirectUri } = input;
	return {
		status: normalizeOAuthStatus(config?.status),
		clientId: truncateClientId(config?.clientId),
		scopes: config?.scopes?.trim() || null,
		expiresAt: config?.expiresAt ?? null,
		connectedAt: config?.connectedAt ?? null,
		connectedBy: connectedByEmail ?? null,
		lastError: redactLastError(config?.lastError),
		redirectUri,
		canManage
	};
}
