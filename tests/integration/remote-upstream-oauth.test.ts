/**
 * Remote HTTP upstreams authenticated with `authMode: 'oauth'`
 * (datadog-mcp-oauth todo 8).
 *
 * The token material is not hand-written: each connected upstream is seeded by
 * driving the fixture's real discovery -> DCR -> authorize -> PKCE exchange
 * flow. `connectRemoteHttp` then has to use the sealed tokens, refresh a stale
 * one exactly once, and keep every byte of token material out of diagnostics and
 * errors. A static bearer upstream is included as the byte-for-byte regression.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { resetConfigCache } from '../../src/lib/server/config';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { schema } from '../../src/lib/server/db/schema';
import { sealSecret } from '../../src/lib/server/security/vault';
import { uuidv7 } from '../../src/lib/shared/ids';
import { connectRemoteHttp } from '../../src/lib/server/upstream/remote-http';
import {
	createOAuthProvider,
	OAuthAuthorizationRequiredError
} from '../../src/lib/server/upstream/oauth/provider';
import {
	getOAuthConfig,
	readTokenSecret,
	upsertOAuthConfig
} from '../../src/lib/server/upstream/oauth/store';
import {
	UnconfiguredUpstreamError,
	type UpstreamHandle,
	type UpstreamRecord
} from '../../src/lib/server/upstream/types';
import { startFixtureHttpServer, type FixtureHttpServer } from '../fixtures/http-mcp-server';
import { startOAuthFixture, type OAuthFixture } from '../fixtures/oauth-server';

const PUBLIC_URL = new URL('https://gateway.example.test');
const STATIC_SECRET_NAME = 'oauth-remote-static-token';
const STATIC_CREDENTIAL = 'static-bearer-credential-3f9c';

let dir: string;
let fixture: OAuthFixture;
const handles: UpstreamHandle[] = [];

type SeededUpstream = { id: string; slug: string };

function insertOAuthUpstream(url = fixture.mcpUrl): SeededUpstream {
	const id = uuidv7();
	const slug = `oauth-remote-${id.slice(-8)}`;
	getDb()
		.insert(schema.upstreams)
		.values({
			id,
			slug,
			name: 'OAuth remote upstream',
			transport: 'http',
			connection: { url, authMode: 'oauth' }
		})
		.run();
	return { id, slug };
}

function recordFor(upstream: SeededUpstream, connection: Record<string, unknown>): UpstreamRecord {
	return {
		id: upstream.id,
		slug: upstream.slug,
		name: 'OAuth remote upstream',
		transport: 'http',
		enabled: true,
		connection: connection as unknown as UpstreamRecord['connection'],
		envRefs: {},
		timeoutMs: 5_000,
		pin: 'pinned'
	};
}

function oauthRecord(upstream: SeededUpstream): UpstreamRecord {
	return recordFor(upstream, { url: fixture.mcpUrl, authMode: 'oauth' });
}

function providerFor(upstream: SeededUpstream) {
	return createOAuthProvider({
		upstreamId: upstream.id,
		slug: upstream.slug,
		serverUrl: fixture.mcpUrl,
		publicUrl: PUBLIC_URL,
		scopes: 'mcp_all'
	});
}

async function seedFromFixtureFlow(upstream: SeededUpstream): Promise<void> {
	const provider = providerFor(upstream);
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
	const code = new URL(authorization.headers.get('location') as string).searchParams.get('code');
	expect(typeof code).toBe('string');

	const result = await auth(provider, {
		serverUrl: fixture.mcpUrl,
		authorizationCode: code as string,
		fetchFn: fetch
	});
	expect(result).toBe('AUTHORIZED');
}

type ObservedRequest = { authorization: string | null; trace: string | null };

function startHeaderCapturingProxy(targetUrl: string): {
	url: string;
	observed: ObservedRequest[];
	stop(): void;
} {
	const observed: ObservedRequest[] = [];
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			observed.push({
				authorization: request.headers.get('authorization'),
				trace: request.headers.get('x-trace')
			});
			const body =
				request.method === 'GET' || request.method === 'HEAD'
					? undefined
					: await request.arrayBuffer();
			return fetch(targetUrl, {
				method: request.method,
				headers: request.headers,
				body,
				redirect: 'manual'
			});
		}
	});
	return {
		url: `http://127.0.0.1:${server.port as number}/mcp`,
		observed,
		stop() {
			server.stop(true);
		}
	};
}

function insertStaticSecret(name: string, value: string): void {
	const sealed = sealSecret(value);
	getDb()
		.insert(schema.secretRefs)
		.values({
			id: uuidv7(),
			name,
			cipher: sealed.cipher,
			iv: sealed.iv,
			tag: sealed.tag,
			keyVer: sealed.keyVer
		})
		.run();
}

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-remote-oauth-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '55'.repeat(32);
	process.env.MCPGW_PUBLIC_URL = PUBLIC_URL.origin;
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	fixture = await startOAuthFixture({ refreshMode: 'reusable' });
});

afterAll(async () => {
	for (const handle of handles) await handle.close().catch(() => undefined);
	fixture?.stop();
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('connectRemoteHttp — oauth', () => {
	test('lists tools for an upstream seeded by the fixture authorization flow', async () => {
		const upstream = insertOAuthUpstream();
		await seedFromFixtureFlow(upstream);

		const oauthConfig = getOAuthConfig(upstream.id);
		expect(oauthConfig?.clientId).toBeString();
		expect(oauthConfig?.accessTokenRef).toBeString();
		expect(oauthConfig?.refreshTokenRef).toBeString();

		const registerCount = fixture.requests.register;
		const authorizeCount = fixture.requests.authorize;
		const handle = await connectRemoteHttp({ record: oauthRecord(upstream) });
		handles.push(handle);

		const { tools } = await handle.listTools();
		expect(tools.map((tool) => tool.name)).toContain('echo');
		expect(fixture.requests.register).toBeGreaterThanOrEqual(registerCount);
		expect(fixture.requests.authorize).toBeGreaterThanOrEqual(authorizeCount);
		expect(
			fixture.tokenRequests.some((request) => request.grant_type === 'authorization_code')
		).toBe(true);
	});

	test('fails closed with authorization_required when no token is stored', async () => {
		const upstream = insertOAuthUpstream();
		upsertOAuthConfig(upstream.id, {
			status: 'disconnected',
			clientId: 'dcr-client-without-tokens',
			scopes: 'mcp_all'
		});
		const statuses: Array<{ kind: string; reason?: string }> = [];
		const mcpBefore = fixture.requests.mcp;
		const tokenBefore = fixture.requests.token;

		let error: unknown;
		try {
			await connectRemoteHttp({
				record: oauthRecord(upstream),
				onStatusChange: (status) => statuses.push(status)
			});
		} catch (cause) {
			error = cause;
		}

		expect(error).toBeInstanceOf(UnconfiguredUpstreamError);
		expect((error as Error).message).toMatch(/authorization required/i);
		expect(statuses).toContainEqual({ kind: 'unconfigured', reason: 'authorization_required' });
		expect(fixture.requests.mcp).toBe(mcpBefore);
		expect(fixture.requests.token).toBe(tokenBefore);
	});

	test('refreshes an expired token exactly once and then connects', async () => {
		fixture.setRefreshMode('reusable');
		const upstream = insertOAuthUpstream();
		await seedFromFixtureFlow(upstream);
		const provider = providerFor(upstream);
		provider.saveTokens({
			access_token: 'stale-access-token-below-skew',
			token_type: 'Bearer',
			expires_in: 30
		});
		const tokenBefore = fixture.requests.token;

		const handle = await connectRemoteHttp({ record: oauthRecord(upstream) });
		handles.push(handle);

		const { tools } = await handle.listTools();
		expect(tools.map((tool) => tool.name)).toContain('echo');
		const echo = await handle.callTool('echo', { text: 'oauth' });
		expect(JSON.stringify(echo.content)).toContain('echo:oauth');
		expect(fixture.requests.token).toBe(tokenBefore + 1);
	});

	test('diagnostics never contain an access or refresh token', async () => {
		const upstream = insertOAuthUpstream();
		await seedFromFixtureFlow(upstream);
		const handle = await connectRemoteHttp({ record: oauthRecord(upstream) });
		handles.push(handle);
		await handle.listTools();

		const oauthConfig = getOAuthConfig(upstream.id);
		const accessToken = oauthConfig?.accessTokenRef
			? readTokenSecret(oauthConfig.accessTokenRef)
			: undefined;
		const refreshToken = oauthConfig?.refreshTokenRef
			? readTokenSecret(oauthConfig.refreshTokenRef)
			: undefined;
		expect(accessToken).toBeString();
		expect(refreshToken).toBeString();

		const diagnostics = JSON.stringify(handle.diagnostics());
		expect(diagnostics).not.toContain(accessToken as string);
		expect(diagnostics).not.toContain(refreshToken as string);
	});

	test('strips authorization overrides from connection.headers but keeps other headers', async () => {
		const upstream = insertOAuthUpstream();
		await seedFromFixtureFlow(upstream);
		const proxy = startHeaderCapturingProxy(fixture.mcpUrl);
		const attackerToken = 'Bearer attacker-token-should-not-reach';
		try {
			const handle = await connectRemoteHttp({
				record: recordFor(upstream, {
					url: proxy.url,
					authMode: 'oauth',
					headers: {
						Authorization: attackerToken,
						'proxy-authorization': 'Basic attacker-proxy',
						'X-Trace': 'trace-1'
					}
				})
			});
			handles.push(handle);
			const { tools } = await handle.listTools();
			expect(tools.map((tool) => tool.name)).toContain('echo');

			const oauthConfig = getOAuthConfig(upstream.id);
			const accessToken = oauthConfig?.accessTokenRef
				? readTokenSecret(oauthConfig.accessTokenRef)
				: undefined;
			expect(accessToken).toBeString();

			expect(proxy.observed.length).toBeGreaterThan(0);
			const authorizations = proxy.observed.map((request) => request.authorization);
			expect(authorizations).not.toContain(attackerToken);
			expect(authorizations.every((value) => value === `Bearer ${accessToken}`)).toBe(true);
			expect(proxy.observed.every((request) => request.trace === 'trace-1')).toBe(true);
		} finally {
			proxy.stop();
		}
	});

	test('refuses an oauth upstream that also carries a static authRef', async () => {
		const upstream = insertOAuthUpstream();
		upsertOAuthConfig(upstream.id, { clientId: 'dcr-client-mixed', scopes: 'mcp_all' });
		const mcpBefore = fixture.requests.mcp;

		let error: unknown;
		try {
			await connectRemoteHttp({
				record: recordFor(upstream, {
					url: fixture.mcpUrl,
					authMode: 'oauth',
					authRef: 'secret:legacy-static-token'
				})
			});
		} catch (cause) {
			error = cause;
		}

		expect(error).toBeInstanceOf(UnconfiguredUpstreamError);
		expect((error as Error).message).toMatch(/configuration/i);
		expect(fixture.requests.mcp).toBe(mcpBefore);
	});
});

describe('connectRemoteHttp — static regression', () => {
	test('still sends the same Authorization bearer header', async () => {
		insertStaticSecret(STATIC_SECRET_NAME, STATIC_CREDENTIAL);
		const httpFixture: FixtureHttpServer = await startFixtureHttpServer({
			requireBearer: STATIC_CREDENTIAL
		});
		try {
			const id = uuidv7();
			const upstream: SeededUpstream = {
				id,
				slug: `static-remote-${id.slice(-8)}`
			};
			const handle = await connectRemoteHttp({
				record: recordFor(upstream, {
					url: httpFixture.url,
					authMode: 'static',
					authStyle: 'bearer',
					authRef: `secret:${STATIC_SECRET_NAME}`
				})
			});
			handles.push(handle);
			const { tools } = await handle.listTools();
			expect(tools.map((tool) => tool.name)).toContain('echo');
			expect(httpFixture.requests.lastAuthorization).toBe(`Bearer ${STATIC_CREDENTIAL}`);
		} finally {
			httpFixture.stop();
		}
	});
});
