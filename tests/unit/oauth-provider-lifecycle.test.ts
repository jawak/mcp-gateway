/**
 * OAuth provider lifecycle (datadog-mcp-oauth todo 6).
 *
 * Covers the parts of the SDK provider that survive across requests: reloading
 * sealed tokens, expiry math, refresh-token preservation, PKCE verifier lookup
 * from a freshly constructed provider, persisted initiator identity, and the
 * exact credential-invalidation scopes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { resetConfigCache } from '../../src/lib/server/config';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { getDb, getSqlite, useDatabaseForTests } from '../../src/lib/server/db';
import { schema } from '../../src/lib/server/db/schema';
import { sealSecret } from '../../src/lib/server/security/vault';
import { uuidv7 } from '../../src/lib/shared/ids';
import {
	createOAuthProvider,
	OAuthStateError,
	type OAuthProvider
} from '../../src/lib/server/upstream/oauth/provider';
import {
	createPending,
	deletePendingForUpstream,
	getOAuthConfig,
	getPending,
	oauthTokenName,
	readTokenSecret
} from '../../src/lib/server/upstream/oauth/store';

const PUBLIC_URL = new URL('https://gateway.example.test');
const REDIRECT_URI = 'https://gateway.example.test/oauth/callback';
const ACCESS = 'lifecycle-access-token-4c9e';
const ROTATED_ACCESS = 'lifecycle-rotated-access-7b2d';
const REFRESH = 'lifecycle-refresh-token-6d2a';
const CLIENT_SECRET = 'lifecycle-client-secret-8f1b';
const VERIFIER = 'lifecycle-pkce-verifier-2a7c';

let dir: string;

type Upstream = { id: string; slug: string };

function insertUpstream(): Upstream {
	const id = uuidv7();
	const slug = `oauth-lifecycle-${id.slice(-8)}`;
	getDb()
		.insert(schema.upstreams)
		.values({
			id,
			slug,
			name: 'OAuth lifecycle upstream',
			transport: 'http',
			connection: { url: 'https://mcp.example.test/mcp', authMode: 'oauth' }
		})
		.run();
	return { id, slug };
}

function insertUser(): string {
	const id = uuidv7();
	getDb()
		.insert(schema.users)
		.values({
			id,
			email: `lifecycle-${id.slice(-8)}@example.test`,
			passwordHash: 'not-a-real-hash',
			role: 'admin'
		})
		.run();
	return id;
}

function providerFor(
	upstream: Upstream,
	options: { createdBy?: string | null } = {}
): OAuthProvider {
	return createOAuthProvider({
		upstreamId: upstream.id,
		slug: upstream.slug,
		serverUrl: 'https://mcp.example.test/mcp',
		publicUrl: PUBLIC_URL,
		scopes: 'mcp_all',
		...options
	});
}

function rawSecret(name: string): { cipher: string; iv: string; tag: string } | undefined {
	return (
		(getSqlite().prepare('select cipher, iv, tag from secret_refs where name = ?').get(name) as {
			cipher: string;
			iv: string;
			tag: string;
		} | null) ?? undefined
	);
}

function discovery(): OAuthDiscoveryState {
	return {
		authorizationServerUrl: 'https://auth.example.test/v1/mcp',
		resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource',
		authorizationServerMetadata: {
			issuer: 'https://auth.example.test/v1/mcp',
			authorization_endpoint: 'https://auth.example.test/authorize',
			token_endpoint: 'https://auth.example.test/token',
			registration_endpoint: 'https://auth.example.test/register',
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			scopes_supported: ['mcp_all'],
			token_endpoint_auth_methods_supported: ['none']
		}
	};
}

/** Give an upstream a client, tokens, discovery, and one pending verifier. */
function seedCredentials(upstream: Upstream, provider: OAuthProvider): string {
	provider.saveClientInformation({
		client_id: `client-${upstream.slug}`,
		client_secret: CLIENT_SECRET
	});
	provider.saveTokens({
		access_token: ACCESS,
		token_type: 'Bearer',
		refresh_token: REFRESH,
		expires_in: 3600,
		scope: 'mcp_all'
	});
	provider.saveDiscoveryState(discovery());
	const state = provider.state();
	provider.saveCodeVerifier(VERIFIER);
	return state;
}

function expectStateError(fn: () => unknown, code: string): void {
	let caught: unknown;
	try {
		fn();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(OAuthStateError);
	expect((caught as OAuthStateError).code).toBe(code);
}

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-lifecycle-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '33'.repeat(32);
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

afterAll(() => {
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('tokens', () => {
	test('is undefined without an access token and reloads every saved field', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		expect(provider.tokens()).toBeUndefined();

		provider.saveTokens({
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 3600,
			scope: 'mcp_all'
		});

		const reloaded = providerFor(upstream).tokens();
		expect(reloaded).toBeDefined();
		expect(reloaded?.access_token).toBe(ACCESS);
		expect(reloaded?.refresh_token).toBe(REFRESH);
		expect(reloaded?.token_type).toBe('Bearer');
		expect(reloaded?.scope).toBe('mcp_all');
		expect(reloaded?.expires_in).toBeGreaterThan(0);
	});

	test('derives expires_in from expires_at, counts down, and clamps at zero', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const startedAt = Date.now();
		provider.saveTokens({ access_token: ACCESS, token_type: 'Bearer', expires_in: 3600 });

		const initial = provider.tokens()?.expires_in;
		expect(initial).toBeGreaterThanOrEqual(3599);
		expect(initial).toBeLessThanOrEqual(3600);

		const realNow = Date.now;
		try {
			Date.now = () => startedAt + 600_000;
			const countedDown = provider.tokens()?.expires_in;
			expect(countedDown).toBeGreaterThanOrEqual(2999);
			expect(countedDown).toBeLessThanOrEqual(3000);

			Date.now = () => startedAt + 4_000_000;
			expect(provider.tokens()?.expires_in).toBe(0);
		} finally {
			Date.now = realNow;
		}
	});

	test('leaves expires_in undefined (and expiry null) when the server omits it', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		provider.saveTokens({ access_token: ACCESS, token_type: 'Bearer' });

		expect(provider.tokens()?.expires_in).toBeUndefined();
		expect(getOAuthConfig(upstream.id)?.expiresAt).toBeNull();
	});

	test('preserves the old refresh token when a refresh response omits it', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		provider.saveTokens({
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 60
		});

		provider.saveTokens({ access_token: ROTATED_ACCESS, token_type: 'Bearer', expires_in: 60 });

		expect(provider.tokens()?.access_token).toBe(ROTATED_ACCESS);
		expect(provider.tokens()?.refresh_token).toBe(REFRESH);
	});
});

describe('code verifier', () => {
	test('resolves the newest pending verifier from a fresh provider instance', () => {
		const upstream = insertUpstream();
		const authorizing = providerFor(upstream);
		const state = authorizing.state();
		authorizing.saveCodeVerifier(VERIFIER);

		const callback = providerFor(upstream);
		expect(callback.codeVerifier()).toBe(VERIFIER);
		expect(getPending(state)).toBeDefined();
	});

	test('throws a typed error for an expired pending row', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const state = provider.state();
		provider.saveCodeVerifier(VERIFIER);
		getSqlite()
			.prepare('update upstream_oauth_pending set expires_at = ? where state = ?')
			.run(new Date(Date.now() - 1_000).toISOString(), state);

		expectStateError(() => provider.codeVerifier(), 'missing_code_verifier');
		expectStateError(() => providerFor(upstream).codeVerifier(), 'missing_code_verifier');
	});

	test('throws a typed error when no pending row exists', () => {
		const upstream = insertUpstream();
		expectStateError(() => providerFor(upstream).codeVerifier(), 'missing_code_verifier');
	});

	test('saveCodeVerifier rejects a missing pending state instead of silently no-oping', () => {
		const noState = insertUpstream();
		expectStateError(
			() => providerFor(noState).saveCodeVerifier(VERIFIER),
			'missing_pending_state'
		);

		const deletedState = insertUpstream();
		const provider = providerFor(deletedState);
		provider.state();
		deletePendingForUpstream(deletedState.id);
		expectStateError(() => provider.saveCodeVerifier(VERIFIER), 'missing_pending_state');
	});
});

describe('pending initiator', () => {
	test('persists createdBy when the provider is constructed with one', () => {
		const upstream = insertUpstream();
		const userId = insertUser();
		const provider = providerFor(upstream, { createdBy: userId });
		const state = provider.state();

		expect(getPending(state)?.createdBy).toBe(userId);
	});

	test('defaults createdBy to null when the provider omits it', () => {
		const upstream = insertUpstream();
		const state = providerFor(upstream).state();
		expect(getPending(state)?.createdBy).toBeNull();
	});
});

describe('client information rotation', () => {
	test('drops a stale sealed secret when DCR returns a new client without one', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		provider.saveClientInformation({ client_id: 'client-one', client_secret: CLIENT_SECRET });
		expect(rawSecret(oauthTokenName(upstream.slug, 'client_secret'))).toBeDefined();

		provider.saveClientInformation({ client_id: 'client-two' });

		expect(provider.clientInformation()).toEqual({ client_id: 'client-two' });
		expect(getOAuthConfig(upstream.id)?.clientSecretRef).toBeNull();
		expect(rawSecret(oauthTokenName(upstream.slug, 'client_secret'))).toBeUndefined();
	});

	test('clears the existing secret for the same client id when it is omitted', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		provider.saveClientInformation({ client_id: 'client-same', client_secret: CLIENT_SECRET });
		provider.saveClientInformation({ client_id: 'client-same' });

		expect(provider.clientInformation()).toEqual({ client_id: 'client-same' });
		expect(getOAuthConfig(upstream.id)?.clientSecretRef).toBeNull();
		expect(rawSecret(oauthTokenName(upstream.slug, 'client_secret'))).toBeUndefined();
	});

	test('clears an orphaned sealed secret when the stored client id is null', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const secretName = oauthTokenName(upstream.slug, 'client_secret');
		provider.saveClientInformation({ client_id: 'client-a', client_secret: CLIENT_SECRET });
		getSqlite()
			.prepare('update upstream_oauth set client_id = null where upstream_id = ?')
			.run(upstream.id);

		expect(getOAuthConfig(upstream.id)?.clientId).toBeNull();
		expect(getOAuthConfig(upstream.id)?.clientSecretRef).toBe(secretName);
		expect(provider.clientInformation()).toBeUndefined();

		provider.saveClientInformation({ client_id: 'client-b' });

		expect(provider.clientInformation()).toEqual({ client_id: 'client-b' });
		expect(getOAuthConfig(upstream.id)?.clientSecretRef).toBeNull();
		expect(rawSecret(secretName)).toBeUndefined();
	});
});

describe('invalidateCredentials', () => {
	test("'tokens' clears only the access/refresh tokens", () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const state = seedCredentials(upstream, provider);

		provider.invalidateCredentials('tokens');

		expect(provider.tokens()).toBeUndefined();
		expect(rawSecret(oauthTokenName(upstream.slug, 'access'))).toBeUndefined();
		expect(rawSecret(oauthTokenName(upstream.slug, 'refresh'))).toBeUndefined();
		expect(provider.clientInformation()).toBeDefined();
		expect(provider.discoveryState()).toBeDefined();
		expect(getPending(state)).toBeDefined();
	});

	test("'client' clears only the client id and sealed client secret", () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const state = seedCredentials(upstream, provider);

		provider.invalidateCredentials('client');

		expect(provider.clientInformation()).toBeUndefined();
		expect(getOAuthConfig(upstream.id)?.clientId).toBeNull();
		expect(getOAuthConfig(upstream.id)?.clientSecretRef).toBeNull();
		expect(rawSecret(oauthTokenName(upstream.slug, 'client_secret'))).toBeUndefined();
		expect(provider.tokens()).toBeDefined();
		expect(provider.discoveryState()).toBeDefined();
		expect(getPending(state)).toBeDefined();
	});

	test("'verifier' deletes only the pending authorization flow", () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const state = seedCredentials(upstream, provider);

		provider.invalidateCredentials('verifier');

		expect(getPending(state)).toBeUndefined();
		expect(provider.tokens()).toBeDefined();
		expect(provider.clientInformation()).toBeDefined();
		expect(provider.discoveryState()).toBeDefined();
	});

	test("'discovery' clears only the cached discovery JSON", () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const state = seedCredentials(upstream, provider);

		provider.invalidateCredentials('discovery');

		expect(provider.discoveryState()).toBeUndefined();
		expect(getOAuthConfig(upstream.id)?.discovery).toBeNull();
		expect(provider.tokens()).toBeDefined();
		expect(provider.clientInformation()).toBeDefined();
		expect(getPending(state)).toBeDefined();
	});

	test("'all' clears every credential and pending flow", () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const state = seedCredentials(upstream, provider);

		provider.invalidateCredentials('all');

		expect(provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()).toBeUndefined();
		expect(provider.discoveryState()).toBeUndefined();
		expect(getPending(state)).toBeUndefined();
		expect(readTokenSecret(oauthTokenName(upstream.slug, 'refresh'))).toBeUndefined();
	});

	test('ignores an unknown scope', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const state = seedCredentials(upstream, provider);

		(provider as unknown as { invalidateCredentials(scope: string): void }).invalidateCredentials(
			'not-a-scope'
		);

		expect(provider.tokens()).toBeDefined();
		expect(provider.clientInformation()).toBeDefined();
		expect(provider.discoveryState()).toBeDefined();
		expect(getPending(state)).toBeDefined();
	});
});

describe('no plaintext leakage', () => {
	test('tokens, client secret, and verifier never appear in the DB, audit, or state errors', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		provider.saveClientInformation({ client_id: 'leak-check', client_secret: CLIENT_SECRET });
		provider.saveTokens({
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 60,
			scope: 'mcp_all'
		});
		const state = provider.state();
		provider.saveCodeVerifier(VERIFIER);

		const databaseDump = [
			'select * from secret_refs',
			'select * from upstream_oauth',
			'select * from upstream_oauth_pending',
			'select * from audit_log'
		]
			.map((sql) => JSON.stringify(getSqlite().prepare(sql).all()))
			.join('\n');

		const errors: string[] = [];
		const other = insertUpstream();
		try {
			providerFor(other).codeVerifier();
		} catch (error) {
			errors.push((error as Error).message);
		}
		try {
			providerFor(insertUpstream()).saveCodeVerifier(VERIFIER);
		} catch (error) {
			errors.push((error as Error).message);
		}

		for (const value of [ACCESS, REFRESH, CLIENT_SECRET, VERIFIER]) {
			expect(databaseDump).not.toContain(value);
			expect(errors.join('\n')).not.toContain(value);
		}
		expect(getPending(state)?.verifierSealed).not.toContain(VERIFIER);
	});
});

describe('pending row seeding', () => {
	test('createPending persists createdBy when provided directly', () => {
		const upstream = insertUpstream();
		const userId = insertUser();
		const state = uuidv7();
		createPending({
			state,
			upstreamId: upstream.id,
			redirectUri: REDIRECT_URI,
			createdBy: userId,
			ttlMs: 60_000,
			verifierSealed: JSON.stringify(sealSecret(VERIFIER))
		});

		expect(getPending(state)?.createdBy).toBe(userId);
	});
});
