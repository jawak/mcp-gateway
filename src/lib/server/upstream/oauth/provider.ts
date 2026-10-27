/**
 * OAuth client provider for one HTTP upstream (datadog-mcp-oauth todo 5).
 *
 * This module adapts the vault-backed store to the MCP SDK's atomic
 * `OAuthClientProvider` contract. It never navigates: the admin action turns
 * `OAuthAuthorizationRequiredError.authorizationUrl` into its own redirect.
 */
import { randomBytes } from 'node:crypto';
import type {
	OAuthClientProvider,
	OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
	clearTokens,
	createPending,
	deletePendingForUpstream,
	deleteTokenSecret,
	getOAuthConfig,
	readClientSecret,
	readPendingVerifier,
	readTokenSecret,
	saveClientSecret,
	savePendingVerifier,
	saveTokens as persistTokens,
	upsertOAuthConfig
} from './store.ts';

const PENDING_TTL_MS = 10 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export type OAuthProviderOptions = {
	upstreamId: string;
	slug: string;
	serverUrl: string | URL;
	publicUrl: URL;
	scopes: string;
};

export type OAuthProvider = Omit<
	OAuthClientProvider,
	| 'state'
	| 'codeVerifier'
	| 'saveClientInformation'
	| 'discoveryState'
	| 'saveDiscoveryState'
	| 'invalidateCredentials'
> & {
	state(): string;
	codeVerifier(): string;
	saveClientInformation(clientInformation: OAuthClientInformationMixed): void;
	discoveryState(): OAuthDiscoveryState | undefined;
	saveDiscoveryState(discovery: OAuthDiscoveryState): void;
	invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void;
};

/** The OAuth server must send the user agent here; no navigation has happened. */
export class OAuthAuthorizationRequiredError extends Error {
	readonly authorizationUrl: string;
	readonly upstreamId: string;

	constructor(authorizationUrl: string | URL, upstreamId: string) {
		super('OAuth authorization required');
		this.name = 'OAuthAuthorizationRequiredError';
		this.authorizationUrl = String(authorizationUrl);
		this.upstreamId = upstreamId;
	}
}

/** A pending authorization state is missing, expired, or unusable. */
export class OAuthStateError extends Error {
	readonly code: string;

	constructor(code: string, message = code) {
		super(message);
		this.name = 'OAuthStateError';
		this.code = code;
	}
}

/** The authorization server does not support this gateway's public-client profile. */
export class UnsupportedAuthMethodError extends Error {
	constructor(message = 'authorization server does not support public clients') {
		super(message);
		this.name = 'UnsupportedAuthMethodError';
	}
}

function isAllowedAuthorizationUrl(url: URL): boolean {
	if (url.protocol === 'https:') return true;
	return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

function supportedAuthMethods(discovery: OAuthDiscoveryState): string[] | undefined {
	const methods = discovery.authorizationServerMetadata?.token_endpoint_auth_methods_supported;
	return Array.isArray(methods) ? methods : undefined;
}

class StoreBackedOAuthProvider implements OAuthProvider {
	readonly #upstreamId: string;
	readonly #publicUrl: URL;
	readonly #scopes: string;
	#pendingState: string | undefined;

	constructor(options: OAuthProviderOptions) {
		this.#upstreamId = options.upstreamId;
		this.#publicUrl = options.publicUrl;
		this.#scopes = options.scopes;
	}

	get redirectUrl(): string {
		return `${this.#publicUrl.origin}/oauth/callback`;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: `mcp-gateway (${this.#publicUrl.host})`,
			redirect_uris: [this.redirectUrl],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: this.#scopes
		};
	}

	state(): string {
		const state = randomBytes(32).toString('base64url');
		createPending({
			state,
			upstreamId: this.#upstreamId,
			redirectUri: this.redirectUrl,
			ttlMs: PENDING_TTL_MS
		});
		this.#pendingState = state;
		return state;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		const config = getOAuthConfig(this.#upstreamId);
		if (!config?.clientId) return undefined;

		const information: OAuthClientInformationMixed = { client_id: config.clientId };
		const secret = readClientSecret(this.#upstreamId);
		if (secret) information.client_secret = secret;
		return information;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		upsertOAuthConfig(this.#upstreamId, { clientId: clientInformation.client_id });
		if (clientInformation.client_secret) {
			saveClientSecret(this.#upstreamId, clientInformation.client_secret);
		}
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		const discovery = getOAuthConfig(this.#upstreamId)?.discovery;
		return discovery ? (discovery as unknown as OAuthDiscoveryState) : undefined;
	}

	saveDiscoveryState(discovery: OAuthDiscoveryState): void {
		const methods = supportedAuthMethods(discovery);
		if (methods && methods.length > 0 && !methods.includes('none')) {
			throw new UnsupportedAuthMethodError();
		}

		const metadata = discovery.authorizationServerMetadata;
		upsertOAuthConfig(this.#upstreamId, {
			discovery: JSON.parse(JSON.stringify(discovery)) as Record<string, unknown>,
			authorizationServerUrl: discovery.authorizationServerUrl ?? null,
			resourceMetadataUrl: discovery.resourceMetadataUrl ?? null,
			authorizationEndpoint: metadata ? String(metadata.authorization_endpoint) : null,
			tokenEndpoint: metadata ? String(metadata.token_endpoint) : null,
			registrationEndpoint: metadata?.registration_endpoint
				? String(metadata.registration_endpoint)
				: null
		});
	}

	tokens(): OAuthTokens | undefined {
		const config = getOAuthConfig(this.#upstreamId);
		if (!config?.accessTokenRef) return undefined;

		const accessToken = readTokenSecret(config.accessTokenRef);
		if (!accessToken) return undefined;

		const tokens: OAuthTokens = {
			access_token: accessToken,
			token_type: config.tokenType ?? 'Bearer'
		};
		const refreshToken = config.refreshTokenRef
			? readTokenSecret(config.refreshTokenRef)
			: undefined;
		if (refreshToken) tokens.refresh_token = refreshToken;
		if (config.grantedScope) tokens.scope = config.grantedScope;
		if (config.expiresAt) {
			const remainingMs = Date.parse(config.expiresAt) - Date.now();
			if (Number.isFinite(remainingMs)) {
				tokens.expires_in = Math.max(0, Math.floor(remainingMs / 1000));
			}
		}
		return tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		persistTokens(this.#upstreamId, tokens);
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		if (!isAllowedAuthorizationUrl(authorizationUrl)) {
			throw new OAuthStateError(
				'invalid_authorization_url',
				'authorization URL must use https, or loopback http in tests'
			);
		}
		throw new OAuthAuthorizationRequiredError(authorizationUrl, this.#upstreamId);
	}

	saveCodeVerifier(codeVerifier: string): void {
		if (!this.#pendingState) {
			throw new OAuthStateError('missing_pending_state', 'no pending authorization state');
		}
		savePendingVerifier(this.#pendingState, codeVerifier);
	}

	codeVerifier(): string {
		if (!this.#pendingState) {
			throw new OAuthStateError('missing_code_verifier', 'no pending code verifier');
		}
		const verifier = readPendingVerifier(this.#pendingState);
		if (verifier === undefined) {
			throw new OAuthStateError('missing_code_verifier', 'no pending code verifier');
		}
		return verifier;
	}

	invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
		if (scope === 'client' || scope === 'all') this.#invalidateClient();
		if (scope === 'tokens' || scope === 'all') this.#invalidateTokens();
		if (scope === 'verifier' || scope === 'all') this.#invalidateVerifier();
		if (scope === 'discovery' || scope === 'all') this.#invalidateDiscovery();
	}

	#invalidateClient(): void {
		const config = getOAuthConfig(this.#upstreamId);
		if (!config) return;
		if (config.clientSecretRef) deleteTokenSecret(config.clientSecretRef);
		upsertOAuthConfig(this.#upstreamId, { clientId: null, clientSecretRef: null });
	}

	#invalidateTokens(): void {
		if (!getOAuthConfig(this.#upstreamId)) return;
		clearTokens(this.#upstreamId);
	}

	#invalidateVerifier(): void {
		deletePendingForUpstream(this.#upstreamId);
		this.#pendingState = undefined;
	}

	#invalidateDiscovery(): void {
		if (!getOAuthConfig(this.#upstreamId)) return;
		upsertOAuthConfig(this.#upstreamId, {
			discovery: null,
			authorizationServerUrl: null,
			resourceMetadataUrl: null,
			authorizationEndpoint: null,
			tokenEndpoint: null,
			registrationEndpoint: null
		});
	}
}

export function createOAuthProvider(options: OAuthProviderOptions): OAuthProvider {
	return new StoreBackedOAuthProvider(options);
}
