/**
 * OAuth fetch coordinator (datadog-mcp-oauth todo 7).
 *
 * Proves the two behaviours that keep a shared OAuth upstream alive without
 * stampeding the token endpoint: a single-flight 401 refresh + one retry, and a
 * pre-connect freshness check. The refresh token used here comes from the real
 * fixture authorization-code flow, so the retry path exercises the same token
 * endpoint a production server would.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { resetConfigCache } from '../../src/lib/server/config';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { schema } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import {
	createOAuthProvider,
	OAuthAuthorizationRequiredError,
	type OAuthProvider
} from '../../src/lib/server/upstream/oauth/provider';
import {
	createOAuthFetch,
	ensureFreshAccessToken
} from '../../src/lib/server/upstream/oauth/fetch';
import { startOAuthFixture, type OAuthFixture } from '../fixtures/oauth-server';

const PUBLIC_URL = new URL('https://gateway.example.test');
const SKEW_MS = 60_000;

let dir: string;
let fixture: OAuthFixture;

type Upstream = { id: string; slug: string };

function insertUpstream(url = fixture.mcpUrl): Upstream {
	const id = uuidv7();
	const slug = `oauth-fetch-${id.slice(-8)}`;
	getDb()
		.insert(schema.upstreams)
		.values({
			id,
			slug,
			name: 'OAuth fetch upstream',
			transport: 'http',
			connection: { url, authMode: 'oauth' }
		})
		.run();
	return { id, slug };
}

function providerFor(upstream: Upstream): OAuthProvider {
	return createOAuthProvider({
		upstreamId: upstream.id,
		slug: upstream.slug,
		serverUrl: fixture.mcpUrl,
		publicUrl: PUBLIC_URL,
		scopes: 'mcp_all'
	});
}

function requestInit(): RequestInit {
	return {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream'
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'oauth-fetch-test', version: '1.0.0' }
			}
		})
	};
}

/** Drive the real fixture flow so the refresh token is one the server issued. */
async function connectViaFixture(
	provider: OAuthProvider
): Promise<{ accessToken: string; refreshToken: string }> {
	let caught: unknown;
	try {
		await auth(provider, { serverUrl: fixture.mcpUrl, fetchFn: fetch });
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(OAuthAuthorizationRequiredError);
	const authorizationUrl = new URL((caught as OAuthAuthorizationRequiredError).authorizationUrl);
	const authorization = await fetch(authorizationUrl, { redirect: 'manual' });
	expect(authorization.status).toBe(302);
	const location = authorization.headers.get('location');
	expect(location).not.toBeNull();
	const code = new URL(location as string).searchParams.get('code');
	expect(typeof code).toBe('string');

	const result = await auth(provider, {
		serverUrl: fixture.mcpUrl,
		authorizationCode: code as string,
		fetchFn: fetch
	});
	expect(result).toBe('AUTHORIZED');

	const tokens = provider.tokens();
	expect(tokens?.access_token).toBeString();
	expect(tokens?.refresh_token).toBeString();
	return {
		accessToken: tokens!.access_token,
		refreshToken: tokens!.refresh_token!
	};
}

/** Replace only the access token; the store keeps the existing refresh token. */
function overwriteAccessToken(
	provider: OAuthProvider,
	accessToken: string,
	expiresIn = 3600
): void {
	provider.saveTokens({
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: expiresIn
	});
}

function bearerOf(init: RequestInit | undefined): string | undefined {
	const headers = new Headers(init?.headers);
	return headers.get('authorization') ?? undefined;
}

function spyInvalidations(provider: OAuthProvider): string[] {
	const calls: string[] = [];
	const original = provider.invalidateCredentials.bind(provider);
	provider.invalidateCredentials = (scope) => {
		calls.push(scope);
		original(scope);
	};
	return calls;
}

/** A baseFetch that tags the fixture's 401 so we can prove the original response survives. */
function taggingBaseFetch(counts: { mcp: number }): FetchLike {
	return async (input, init) => {
		const url = new URL(input.toString());
		if (url.pathname === '/mcp') counts.mcp += 1;
		const response = await fetch(input, init);
		if (url.pathname === '/mcp' && response.status === 401) {
			return new Response(await response.text(), {
				status: 401,
				headers: { 'x-original-401': 'yes' }
			});
		}
		return response;
	};
}

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-fetch-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '44'.repeat(32);
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	fixture = await startOAuthFixture({ refreshMode: 'delay', refreshDelayMs: 50 });
});

afterAll(() => {
	fixture?.stop();
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('ensureFreshAccessToken', () => {
	test('returns true for a fresh token without touching the token endpoint', async () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		provider.saveTokens({
			access_token: 'fresh-access-token',
			token_type: 'Bearer',
			expires_in: 3600
		});
		const before = fixture.requests.token;

		expect(await ensureFreshAccessToken(provider, SKEW_MS, fetch)).toBe(true);
		expect(fixture.requests.token).toBe(before);
	});

	test('treats an unknown expiry as usable without refreshing', async () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		provider.saveTokens({ access_token: 'unknown-expiry-token', token_type: 'Bearer' });
		const before = fixture.requests.token;

		expect(await ensureFreshAccessToken(provider, SKEW_MS, fetch)).toBe(true);
		expect(fixture.requests.token).toBe(before);
	});

	test('refreshes a near-expiry token once and saves the replacement', async () => {
		fixture.setRefreshMode('reusable');
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const initial = await connectViaFixture(provider);
		overwriteAccessToken(provider, initial.accessToken, 30);
		const before = fixture.requests.token;

		expect(await ensureFreshAccessToken(provider, SKEW_MS, fetch)).toBe(true);

		expect(fixture.requests.token).toBe(before + 1);
		const reloaded = provider.tokens();
		expect(reloaded?.access_token).toBeString();
		expect(reloaded?.access_token).not.toBe(initial.accessToken);
		expect(reloaded?.refresh_token).toBe(initial.refreshToken);
	});

	test('returns false when there is no access token', async () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const before = fixture.requests.token;

		expect(await ensureFreshAccessToken(provider, SKEW_MS, fetch)).toBe(false);
		expect(fixture.requests.token).toBe(before);
	});

	test('returns false near expiry when no refresh token exists', async () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		provider.saveTokens({
			access_token: 'expiring-access-token',
			token_type: 'Bearer',
			expires_in: 30
		});
		const before = fixture.requests.token;

		expect(await ensureFreshAccessToken(provider, SKEW_MS, fetch)).toBe(false);
		expect(fixture.requests.token).toBe(before);
	});

	test('returns false and clears tokens when the refresh is rejected with invalid_grant', async () => {
		fixture.setRefreshMode('reusable');
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const initial = await connectViaFixture(provider);
		overwriteAccessToken(provider, initial.accessToken, 30);
		fixture.setRefreshMode('invalid_grant');
		const before = fixture.requests.token;

		expect(await ensureFreshAccessToken(provider, SKEW_MS, fetch)).toBe(false);

		expect(fixture.requests.token).toBe(before + 1);
		expect(provider.tokens()).toBeUndefined();
	});
	test('clears the client on invalid_client', async () => {
		fixture.setRefreshMode('reusable');
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		await connectViaFixture(provider);
		overwriteAccessToken(provider, 'invalid-client-stale', 30);
		const invalidations = spyInvalidations(provider);
		let tokenPosts = 0;

		const baseFetch: FetchLike = async (input, init) => {
			if (new URL(input.toString()).pathname === '/token') {
				tokenPosts += 1;
				return new Response(JSON.stringify({ error: 'invalid_client' }), {
					status: 400,
					headers: { 'content-type': 'application/json' }
				});
			}
			return fetch(input, init);
		};

		expect(await ensureFreshAccessToken(provider, SKEW_MS, baseFetch, upstream.id)).toBe(false);
		expect(tokenPosts).toBe(1);
		expect(invalidations).toEqual(['all']);
		expect(provider.tokens()).toBeUndefined();
		expect(provider.clientInformation()).toBeUndefined();
	});

	test('keeps valid tokens and does not invalidate on a transient 500', async () => {
		fixture.setRefreshMode('reusable');
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const initial = await connectViaFixture(provider);
		overwriteAccessToken(provider, 'transient-stale', 30);
		const invalidations = spyInvalidations(provider);
		let tokenPosts = 0;

		const baseFetch: FetchLike = async (input, init) => {
			if (new URL(input.toString()).pathname === '/token') {
				tokenPosts += 1;
				return new Response('upstream unavailable', { status: 500 });
			}
			return fetch(input, init);
		};

		expect(await ensureFreshAccessToken(provider, SKEW_MS, baseFetch, upstream.id)).toBe(false);
		expect(tokenPosts).toBe(1);
		expect(invalidations).toEqual([]);
		expect(provider.tokens()?.access_token).toBe('transient-stale');
		expect(provider.tokens()?.refresh_token).toBe(initial.refreshToken);
	});

	test('pre-connect on a fresh provider shares the 401 refresh (plan order)', async () => {
		fixture.setRefreshMode('delay');
		const upstream = insertUpstream();
		const connected = providerFor(upstream);
		await connectViaFixture(connected);
		overwriteAccessToken(connected, 'cross-path-stale', 30);
		const before = fixture.requests.token;

		const oauthFetch = createOAuthFetch({
			upstreamId: upstream.id,
			baseFetch: fetch,
			provider: connected
		});
		const freshProvider = providerFor(upstream);
		const [fresh, response] = await Promise.all([
			ensureFreshAccessToken(freshProvider, SKEW_MS),
			oauthFetch(fixture.mcpUrl, requestInit())
		]);

		expect(fresh).toBe(true);
		expect(response.status).toBe(200);
		expect(fixture.requests.token).toBe(before + 1);
	});
});

describe('createOAuthFetch', () => {
	test('two concurrent 401s share exactly one refresh and both retries succeed', async () => {
		fixture.setRefreshMode('delay');
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const initial = await connectViaFixture(provider);
		overwriteAccessToken(provider, 'stale-access-token', 3600);
		const before = fixture.requests.token;
		const refreshBefore = fixture.tokenRequests.filter(
			(record) => record.grant_type === 'refresh_token'
		).length;

		const oauthFetch = createOAuthFetch({ upstreamId: upstream.id, baseFetch: fetch, provider });
		const [first, second] = await Promise.all([
			oauthFetch(fixture.mcpUrl, requestInit()),
			oauthFetch(fixture.mcpUrl, requestInit())
		]);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(fixture.requests.token).toBe(before + 1);
		const refreshRequests = fixture.tokenRequests.filter(
			(record) => record.grant_type === 'refresh_token'
		);
		expect(refreshRequests).toHaveLength(refreshBefore + 1);
		expect(provider.tokens()?.access_token).toBeString();
		expect(provider.tokens()?.access_token).not.toBe(initial.accessToken);
	});

	test('retries with a token changed by another request without refreshing', async () => {
		fixture.setRefreshMode('reusable');
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const initial = await connectViaFixture(provider);
		const replacement = fixture.mintToken('replacement-access-token');
		const before = fixture.requests.token;
		const seen: Array<string | undefined> = [];
		let calls = 0;

		const baseFetch: FetchLike = async (input, init) => {
			calls += 1;
			seen.push(bearerOf(init));
			if (calls === 1) {
				overwriteAccessToken(provider, replacement, 3600);
				return new Response('stale', { status: 401 });
			}
			return fetch(input, init);
		};

		const oauthFetch = createOAuthFetch({ upstreamId: upstream.id, baseFetch, provider });
		const response = await oauthFetch(fixture.mcpUrl, requestInit());

		expect(response.status).toBe(200);
		expect(calls).toBe(2);
		expect(seen[0]).toBe(`Bearer ${initial.accessToken}`);
		expect(seen[1]).toBe(`Bearer ${replacement}`);
		expect(fixture.requests.token).toBe(before);
	});

	test('returns the original 401 and invalidates tokens when refresh fails with invalid_grant', async () => {
		fixture.setRefreshMode('reusable');
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const initial = await connectViaFixture(provider);
		overwriteAccessToken(provider, 'stale-access-token', 3600);
		fixture.setRefreshMode('invalid_grant');
		const before = fixture.requests.token;
		const refreshBefore = fixture.tokenRequests.filter(
			(record) => record.grant_type === 'refresh_token'
		).length;
		const counts = { mcp: 0 };

		const oauthFetch = createOAuthFetch({
			upstreamId: upstream.id,
			baseFetch: taggingBaseFetch(counts),
			provider
		});
		const response = await oauthFetch(fixture.mcpUrl, requestInit());

		expect(response.status).toBe(401);
		expect(response.headers.get('x-original-401')).toBe('yes');
		expect(counts.mcp).toBe(1);
		expect(fixture.requests.token).toBe(before + 1);
		const refreshRequests = fixture.tokenRequests.filter(
			(record) => record.grant_type === 'refresh_token'
		);
		expect(refreshRequests).toHaveLength(refreshBefore + 1);
		expect(provider.tokens()).toBeUndefined();
		expect(initial.refreshToken).toBeString();
	});

	test('retries a stream body once without disturbing it', async () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		provider.saveTokens({
			access_token: 'stream-old-token',
			token_type: 'Bearer',
			expires_in: 3600
		});
		let calls = 0;
		let retriedBody = '';

		const baseFetch: FetchLike = async (_input, init) => {
			calls += 1;
			if (calls === 1) {
				provider.saveTokens({
					access_token: 'stream-new-token',
					token_type: 'Bearer',
					expires_in: 3600
				});
				return new Response('stale', { status: 401 });
			}
			retriedBody = await new Response(init?.body as BodyInit).text();
			return new Response('ok', { status: 200 });
		};

		const payload = 'stream-body-payload';
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(payload));
				controller.close();
			}
		});
		const oauthFetch = createOAuthFetch({ upstreamId: upstream.id, baseFetch, provider });
		const response = await oauthFetch('https://mcp.example.test/mcp', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: stream
		});

		expect(response.status).toBe(200);
		expect(calls).toBe(2);
		expect(retriedBody).toBe(payload);
	});

	test('never retries a 500', async () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const sentinel = new Response('boom', { status: 500 });
		let calls = 0;

		const oauthFetch = createOAuthFetch({
			upstreamId: upstream.id,
			baseFetch: async () => {
				calls += 1;
				return sentinel;
			},
			provider
		});
		const response = await oauthFetch(fixture.mcpUrl, requestInit());

		expect(calls).toBe(1);
		expect(response).toBe(sentinel);
		expect(response.status).toBe(500);
	});

	test('passes non-401 responses through unchanged', async () => {
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		for (const status of [200, 403]) {
			const sentinel = new Response(`status-${status}`, { status });
			let calls = 0;
			const oauthFetch = createOAuthFetch({
				upstreamId: upstream.id,
				baseFetch: async () => {
					calls += 1;
					return sentinel;
				},
				provider
			});

			const response = await oauthFetch(fixture.mcpUrl, requestInit());
			expect(response).toBe(sentinel);
			expect(response.status).toBe(status);
			expect(calls).toBe(1);
		}
	});

	test('does not leak plaintext tokens through logs or the returned error path', async () => {
		fixture.setRefreshMode('reusable');
		const upstream = insertUpstream();
		const provider = providerFor(upstream);
		const initial = await connectViaFixture(provider);
		overwriteAccessToken(provider, 'stale-access-token', 3600);
		fixture.setRefreshMode('invalid_grant');

		const captured: string[] = [];
		const original = { log: console.log, warn: console.warn, error: console.error };
		const record = (...args: unknown[]): void => {
			captured.push(args.map((value) => String(value)).join(' '));
		};
		console.log = record;
		console.warn = record;
		console.error = record;

		let caught: unknown;
		try {
			const oauthFetch = createOAuthFetch({ upstreamId: upstream.id, baseFetch: fetch, provider });
			const response = await oauthFetch(fixture.mcpUrl, requestInit());
			captured.push(await response.text());
		} catch (error) {
			caught = error;
		} finally {
			console.log = original.log;
			console.warn = original.warn;
			console.error = original.error;
		}

		const haystack = `${captured.join('\n')}\n${String(caught ?? '')}`;
		expect(haystack).not.toContain(initial.accessToken);
		expect(haystack).not.toContain(initial.refreshToken);
		expect(haystack.toLowerCase()).not.toContain('bearer ');
	});
});
