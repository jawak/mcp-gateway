/**
 * OAuth client provider core (datadog-mcp-oauth todo 5).
 *
 * Proves the provider satisfies the SDK's atomic interface against the local
 * OAuth fixture: metadata, DCR body, single pending state, sealed verifier,
 * sealed client secret, discovery round-trip, public-client enforcement, and
 * the non-navigating authorization signal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auth, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { resetConfigCache } from '../../src/lib/server/config';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { getDb, getSqlite, useDatabaseForTests } from '../../src/lib/server/db';
import { schema } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import {
	createOAuthProvider,
	OAuthAuthorizationRequiredError,
	OAuthStateError,
	UnsupportedAuthMethodError
} from '../../src/lib/server/upstream/oauth/provider';
import {
	getOAuthConfig,
	getPending,
	readPendingVerifier
} from '../../src/lib/server/upstream/oauth/store';
import { startOAuthFixture, type OAuthFixture } from '../fixtures/oauth-server';

const PUBLIC_URL = new URL('https://gateway.example.test');
const REDIRECT_URI = 'https://gateway.example.test/oauth/callback';
const VERIFIER = 'pkce-verifier-value-4f8c2d1a9e';
const CLIENT_SECRET = 'client-secret-value-8b1e5d';

let dir: string;
let fixture: OAuthFixture;

type Upstream = { id: string; slug: string };

function insertUpstream(url = fixture.mcpUrl): Upstream {
	const id = uuidv7();
	const slug = `oauth-provider-${id.slice(-8)}`;
	getDb()
		.insert(schema.upstreams)
		.values({
			id,
			slug,
			name: 'OAuth provider upstream',
			transport: 'http',
			connection: { url, authMode: 'oauth' }
		})
		.run();
	return { id, slug };
}

function providerFor(upstream: Upstream, publicUrl = PUBLIC_URL) {
	return createOAuthProvider({
		upstreamId: upstream.id,
		slug: upstream.slug,
		serverUrl: fixture.mcpUrl,
		publicUrl,
		scopes: 'mcp_all'
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

function decode(cipher: string): string {
	return Buffer.from(cipher, 'base64').toString('utf8');
}

function discovery(overrides: Partial<OAuthDiscoveryState> = {}): OAuthDiscoveryState {
	return {
		authorizationServerUrl: `${fixture.origin}/v1/mcp`,
		resourceMetadataUrl: `${fixture.origin}/.well-known/oauth-protected-resource`,
		authorizationServerMetadata: {
			issuer: `${fixture.origin}/v1/mcp`,
			authorization_endpoint: `${fixture.origin}/authorize`,
			token_endpoint: `${fixture.origin}/token`,
			registration_endpoint: `${fixture.origin}/register`,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			scopes_supported: ['mcp_all'],
			token_endpoint_auth_methods_supported: ['none']
		},
		...overrides
	};
}

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-provider-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '22'.repeat(32);
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	fixture = await startOAuthFixture();
});

afterAll(() => {
	fixture?.stop();
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('client metadata', () => {
	test('exposes the exact public-client DCR metadata for the public host', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);

		expect(provider.redirectUrl).toBe(REDIRECT_URI);
		expect(provider.clientMetadata).toEqual({
			client_name: 'mcp-gateway (gateway.example.test)',
			redirect_uris: [REDIRECT_URI],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: 'mcp_all'
		});
	});
});

describe('authorization state and verifier', () => {
	test('generates unique URL-safe state, replaces the previous pending row, and stores a sealed verifier', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);

		const states = new Set<string>();
		let previous: string | undefined;
		for (let index = 0; index < 100; index += 1) {
			const state = provider.state();
			expect(state.length).toBeGreaterThanOrEqual(43);
			expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
			states.add(state);
			if (previous) expect(getPending(previous)).toBeUndefined();
			previous = state;
		}

		expect(states.size).toBe(100);
		const pendingRows = getSqlite()
			.prepare('select * from upstream_oauth_pending where upstream_id = ?')
			.all(upstream.id) as Array<Record<string, string>>;
		expect(pendingRows).toHaveLength(1);
		const pending = pendingRows[0]!;
		expect(pending.state).toBe(previous!);
		expect(pending.redirect_uri).toBe(REDIRECT_URI);

		const ttl = Date.parse(pending.expires_at) - Date.parse(pending.created_at);
		expect(ttl).toBeGreaterThanOrEqual(10 * 60 * 1000 - 5_000);
		expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);

		provider.saveCodeVerifier(VERIFIER);
		expect(readPendingVerifier(previous!)).toBe(VERIFIER);
		expect(provider.codeVerifier()).toBe(VERIFIER);

		const sealed = JSON.parse(pendingRows[0]!.verifier_sealed) as {
			cipher: string;
			iv: string;
			tag: string;
			keyVer: number;
		};
		expect(sealed.cipher).not.toContain(VERIFIER);
		expect(decode(sealed.cipher)).not.toContain(VERIFIER);
		expect(sealed.iv.length).toBeGreaterThan(0);
		expect(sealed.tag.length).toBeGreaterThan(0);
		expect(typeof sealed.keyVer).toBe('number');
	});

	test('throws a typed state error when no verifier is pending', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		expect(() => provider.codeVerifier()).toThrow(OAuthStateError);
	});
});

describe('client information', () => {
	test('persists the client id and seals a DCR-issued client secret', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);

		expect(provider.clientInformation()).toBeUndefined();

		provider.saveClientInformation({ client_id: 'client-id-123' });
		expect(provider.clientInformation()).toEqual({ client_id: 'client-id-123' });

		provider.saveClientInformation({ client_id: 'client-id-123', client_secret: CLIENT_SECRET });
		expect(provider.clientInformation()).toEqual({
			client_id: 'client-id-123',
			client_secret: CLIENT_SECRET
		});

		const config = getOAuthConfig(upstream.id);
		expect(config?.clientId).toBe('client-id-123');
		expect(config?.clientSecretRef).toBeDefined();
		const stored = rawSecret(config!.clientSecretRef!);
		expect(stored).toBeDefined();
		expect(stored!.cipher).not.toContain(CLIENT_SECRET);
		expect(decode(stored!.cipher)).not.toContain(CLIENT_SECRET);
		const dump = JSON.stringify(getSqlite().prepare('select * from secret_refs').all());
		expect(dump).not.toContain(CLIENT_SECRET);
	});
});

describe('discovery state', () => {
	test('round-trips the SDK discovery object through upstream_oauth', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const state = discovery();

		provider.saveDiscoveryState(state);

		expect(provider.discoveryState()).toEqual(state);
		expect(getOAuthConfig(upstream.id)?.discovery).toEqual(
			state as unknown as Record<string, unknown>
		);
		expect(getOAuthConfig(upstream.id)?.authorizationServerUrl).toBe(state.authorizationServerUrl);
		expect(getOAuthConfig(upstream.id)?.tokenEndpoint).toBe(
			state.authorizationServerMetadata?.token_endpoint
		);
	});

	test('rejects an authorization server that only supports confidential clients', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const confidential = discovery({
			authorizationServerMetadata: {
				issuer: `${fixture.origin}/v1/mcp`,
				authorization_endpoint: `${fixture.origin}/authorize`,
				token_endpoint: `${fixture.origin}/token`,
				response_types_supported: ['code'],
				token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post']
			}
		});

		expect(() => provider.saveDiscoveryState(confidential)).toThrow(UnsupportedAuthMethodError);
	});
});

describe('authorization redirect', () => {
	test('rejects a non-https, non-loopback URL without navigating', () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		expect(() =>
			provider.redirectToAuthorization(new URL('http://example.com/authorize'))
		).toThrow();
		expect(fixture.requests.authorize).toBe(0);
	});

	test('raises the typed authorization signal for https and loopback http URLs', () => {
		const upstream = insertUpstream();
		for (const value of [
			'http://127.0.0.1:1234/authorize',
			'https://auth.example.test/authorize'
		]) {
			const provider = providerFor(upstream);
			let caught: unknown;
			try {
				provider.redirectToAuthorization(new URL(value));
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(OAuthAuthorizationRequiredError);
			expect((caught as OAuthAuthorizationRequiredError).authorizationUrl).toBe(value);
			expect((caught as OAuthAuthorizationRequiredError).upstreamId).toBe(upstream.id);
		}
		expect(fixture.requests.authorize).toBe(0);
	});
});

describe('auth() against the fixture', () => {
	test('registers a public client and returns a complete authorization URL without navigating', async () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);

		let caught: unknown;
		try {
			await auth(provider, { serverUrl: fixture.mcpUrl, fetchFn: fetch });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(OAuthAuthorizationRequiredError);
		const error = caught as OAuthAuthorizationRequiredError;
		const authorizationUrl = new URL(error.authorizationUrl);
		expect(authorizationUrl.origin).toBe(fixture.origin);
		expect(authorizationUrl.searchParams.get('response_type')).toBe('code');
		expect(authorizationUrl.searchParams.get('client_id')).toBeTruthy();
		expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
		expect(authorizationUrl.searchParams.get('state')).toBeTruthy();
		expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorizationUrl.searchParams.get('scope')).toBe('mcp_all');
		expect(authorizationUrl.searchParams.get('resource')).toBe(`${fixture.origin}/`);

		const state = authorizationUrl.searchParams.get('state')!;
		expect(getPending(state)?.upstreamId).toBe(upstream.id);
		expect(readPendingVerifier(state)).toBe(provider.codeVerifier());

		const registration = fixture.registrations.at(-1);
		expect(registration).toBeDefined();
		expect(registration?.token_endpoint_auth_method).toBe('none');
		expect(registration?.redirect_uris).toEqual([REDIRECT_URI]);

		expect(getOAuthConfig(upstream.id)?.clientId).toBe(
			authorizationUrl.searchParams.get('client_id')
		);
	});
});
