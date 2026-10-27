import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isRedirect } from '@sveltejs/kit';
import { resetConfigCache } from '../../src/lib/server/config';
import { getDb, useDatabaseForTests, type Db } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { upstreamOauthPending, users } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import { createUpstream, ensureLoaded } from '../../src/lib/server/registry';
import { decideAccess } from '../../src/lib/server/governance/rbac';
import { secretExists } from '../../src/lib/server/governance/secrets';
import { listAudit } from '../../src/lib/server/observability/audit';
import { createOAuthProvider } from '../../src/lib/server/upstream/oauth/provider';
import {
	getOAuthConfig,
	getPending,
	oauthTokenName,
	upsertOAuthConfig
} from '../../src/lib/server/upstream/oauth/store';
import { actions } from '../../src/routes/admin/upstreams/[slug]/+page.server';
import { startOAuthFixture, type OAuthFixture } from '../fixtures/oauth-server';

const PUBLIC_URL = 'https://gateway.example.test';
const REDIRECT_URI = `${PUBLIC_URL}/oauth/callback`;
const ADMIN_EMAIL = 'admin@example.test';
const VIEWER_EMAIL = 'viewer@example.test';
const GENERIC_ERROR_SENTINEL = 'SENTINEL-GENERIC-ACCESS-TOKEN';

let dir: string;
let db: Db;
let fixture: OAuthFixture;
let adminId: string;
let viewerId: string;

type Role = 'admin' | 'viewer';

type Locals = {
	user: { id: string; email: string; role: Role; status: 'active' };
	sessionId: null;
};

type Upstream = { id: string; slug: string };

const admin: Locals = {
	user: { id: '', email: ADMIN_EMAIL, role: 'admin', status: 'active' },
	sessionId: null
};
const viewer: Locals = {
	user: { id: '', email: VIEWER_EMAIL, role: 'viewer', status: 'active' },
	sessionId: null
};

function createUser(email: string, role: Role): string {
	const id = uuidv7();
	db.insert(users).values({ id, email, passwordHash: 'synthetic-not-a-real-hash', role }).run();
	return id;
}

function seedOAuthUpstream(url: string, scopes = 'mcp_all'): Upstream {
	const slug = `dd-actions-${uuidv7().slice(-8)}`;
	const created = createUpstream(
		{
			slug,
			name: 'Datadog',
			transport: 'http',
			connection: { url, authMode: 'oauth' }
		},
		db
	);
	upsertOAuthConfig(created.id, { status: 'disconnected', scopes }, db);
	return { id: created.id, slug: created.slug };
}

async function callAction(
	name: 'oauthStart' | 'oauthDisconnect',
	slug: string,
	who: Locals
): Promise<{ thrown?: unknown; result?: unknown }> {
	const request = new Request(`http://localhost/admin/upstreams/${slug}?/${name}`, {
		method: 'POST',
		body: new FormData()
	});
	try {
		return {
			result: await actions[name]({
				params: { slug },
				request,
				locals: who,
				getClientAddress: () => '203.0.113.9'
			} as never)
		};
	} catch (error) {
		return { thrown: error };
	}
}

function expectRedirect(thrown: unknown): { status: number; location: string } {
	expect(isRedirect(thrown)).toBe(true);
	const redirect = thrown as { status: number; location: string };
	expect(redirect.status).toBe(303);
	return redirect;
}

function pendingFor(upstreamId: string) {
	return db
		.select()
		.from(upstreamOauthPending)
		.all()
		.filter((row) => row.upstreamId === upstreamId);
}

function startFakeAuthServer(options: { authorizationEndpoint?: string; registerError?: string }): {
	origin: string;
	stop(): void;
} {
	let origin = '';
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
				return new Response('not found', { status: 404 });
			}
			if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
				return Response.json({
					issuer: origin,
					authorization_endpoint: options.authorizationEndpoint ?? `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ['code'],
					grant_types_supported: ['authorization_code', 'refresh_token'],
					code_challenge_methods_supported: ['S256'],
					token_endpoint_auth_methods_supported: ['none'],
					scopes_supported: ['mcp_all']
				});
			}
			if (url.pathname === '/register') {
				if (options.registerError) {
					return Response.json(
						{
							error: 'invalid_client_metadata',
							error_description: options.registerError
						},
						{ status: 400 }
					);
				}
				return Response.json(
					{
						client_id: 'fake-dcr-client',
						redirect_uris: [REDIRECT_URI],
						token_endpoint_auth_method: 'none',
						grant_types: ['authorization_code', 'refresh_token'],
						response_types: ['code']
					},
					{ status: 201 }
				);
			}
			return new Response('not found', { status: 404 });
		}
	});
	origin = `http://127.0.0.1:${server.port as number}`;
	return { origin, stop: () => server.stop(true) };
}

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-actions-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '77'.repeat(32);
	process.env.MCPGW_PUBLIC_URL = PUBLIC_URL;
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	db = getDb();
	ensureLoaded(db);
	adminId = createUser(ADMIN_EMAIL, 'admin');
	viewerId = createUser(VIEWER_EMAIL, 'viewer');
	admin.user.id = adminId;
	viewer.user.id = viewerId;
	fixture = await startOAuthFixture({ refreshMode: 'reusable' });
});

afterAll(() => {
	fixture?.stop();
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('oauthStart', () => {
	test('redirects to the fixture authorization URL and stores the pending state', async () => {
		const upstream = seedOAuthUpstream(fixture.mcpUrl);
		const before = { ...fixture.requests };
		const { thrown } = await callAction('oauthStart', upstream.slug, admin);
		const redirect = expectRedirect(thrown);

		const location = new URL(redirect.location);
		expect(location.origin).toBe(fixture.origin);
		expect(location.pathname).toBe('/authorize');
		expect(location.searchParams.get('response_type')).toBe('code');
		expect(location.searchParams.get('client_id')).toBeString();
		expect(location.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
		expect(location.searchParams.get('state')).toBeString();
		expect(location.searchParams.get('code_challenge_method')).toBe('S256');
		expect(location.searchParams.get('scope')).toBe('mcp_all');
		expect(location.searchParams.get('resource')).toBeString();

		const state = location.searchParams.get('state') as string;
		const pending = getPending(state);
		expect(pending?.upstreamId).toBe(upstream.id);
		expect(pending?.createdBy).toBe(adminId);
		expect(pending?.redirectUri).toBe(REDIRECT_URI);

		const starts = listAudit({ action: 'oauth.connect.start', targetId: upstream.id });
		expect(starts).toHaveLength(1);
		expect(starts[0]?.actorId).toBe(adminId);
		expect(starts[0]?.ip).toBe('203.0.113.9');

		expect(fixture.requests.authorize).toBe(before.authorize);
		expect(fixture.requests.token).toBe(before.token);
	});

	test('a second start replaces the first pending state', async () => {
		const upstream = seedOAuthUpstream(fixture.mcpUrl);
		const first = expectRedirect((await callAction('oauthStart', upstream.slug, admin)).thrown);
		const firstState = new URL(first.location).searchParams.get('state') as string;

		const second = expectRedirect((await callAction('oauthStart', upstream.slug, admin)).thrown);
		const secondState = new URL(second.location).searchParams.get('state') as string;

		expect(secondState).not.toBe(firstState);
		expect(getPending(firstState)).toBeUndefined();
		const rows = pendingFor(upstream.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe(secondState);
	});

	test('an existing non-expired access token short-circuits without calling auth()', async () => {
		const upstream = seedOAuthUpstream(fixture.mcpUrl);
		const provider = createOAuthProvider({
			upstreamId: upstream.id,
			slug: upstream.slug,
			serverUrl: fixture.mcpUrl,
			publicUrl: new URL(PUBLIC_URL),
			scopes: 'mcp_all'
		});
		provider.saveTokens({
			access_token: 'valid-access-token-sentinel',
			token_type: 'Bearer',
			expires_in: 3_600
		});
		const before = { ...fixture.requests };

		const redirect = expectRedirect((await callAction('oauthStart', upstream.slug, admin)).thrown);

		expect(redirect.location).toBe(`/admin/upstreams/${upstream.slug}?connected=1`);
		expect(fixture.requests.register).toBe(before.register);
		expect(fixture.requests.authorize).toBe(before.authorize);
		expect(fixture.requests.token).toBe(before.token);
		expect(fixture.requests.mcp).toBe(before.mcp);
		expect(pendingFor(upstream.id)).toHaveLength(0);
	});

	test('a viewer POST is forbidden by the access policy before the action runs', () => {
		const pathname = '/admin/upstreams/dd-viewer';
		expect(decideAccess({ pathname, method: 'POST', user: viewer.user }).action).toBe('forbidden');
		expect(decideAccess({ pathname, method: 'POST', user: admin.user }).action).toBe('allow');
	});
});

describe('oauthDisconnect', () => {
	test('clears tokens, pending state, and the client, then redirects', async () => {
		const upstream = seedOAuthUpstream(fixture.mcpUrl);
		const start = expectRedirect((await callAction('oauthStart', upstream.slug, admin)).thrown);
		const state = new URL(start.location).searchParams.get('state') as string;

		const provider = createOAuthProvider({
			upstreamId: upstream.id,
			slug: upstream.slug,
			serverUrl: fixture.mcpUrl,
			publicUrl: new URL(PUBLIC_URL),
			scopes: 'mcp_all'
		});
		provider.saveTokens({
			access_token: 'disconnect-access-sentinel',
			refresh_token: 'disconnect-refresh-sentinel',
			token_type: 'Bearer',
			expires_in: 3_600
		});
		expect(getOAuthConfig(upstream.id)?.clientId).toBeString();
		expect(secretExists(oauthTokenName(upstream.slug, 'access'))).toBe(true);

		const redirect = expectRedirect(
			(await callAction('oauthDisconnect', upstream.slug, admin)).thrown
		);

		expect(redirect.location).toBe(`/admin/upstreams/${upstream.slug}?disconnected=1`);
		expect(getOAuthConfig(upstream.id)).toBeUndefined();
		expect(getPending(state)).toBeUndefined();
		expect(secretExists(oauthTokenName(upstream.slug, 'access'))).toBe(false);
		expect(secretExists(oauthTokenName(upstream.slug, 'refresh'))).toBe(false);
		expect(secretExists(oauthTokenName(upstream.slug, 'client_secret'))).toBe(false);

		const audits = listAudit({ action: 'oauth.disconnect', targetId: upstream.id });
		expect(audits).toHaveLength(1);
		expect(audits[0]?.actorId).toBe(adminId);
	});
});

describe('oauthStart failures', () => {
	test('a generic auth error stores a redacted last_error and only a safe query code', async () => {
		const fake = startFakeAuthServer({
			registerError: `registration failed: access_token=${GENERIC_ERROR_SENTINEL}`
		});
		try {
			const upstream = seedOAuthUpstream(`${fake.origin}/mcp`);
			const redirect = expectRedirect(
				(await callAction('oauthStart', upstream.slug, admin)).thrown
			);

			const location = new URL(redirect.location, PUBLIC_URL);
			expect(location.pathname).toBe(`/admin/upstreams/${upstream.slug}`);
			expect([...location.searchParams.keys()]).toEqual(['oauthError']);
			expect(location.searchParams.get('oauthError')).toBe('oauth_failed');
			expect(redirect.location).not.toContain(GENERIC_ERROR_SENTINEL);
			expect(redirect.location).not.toContain(fake.origin);

			const oauth = getOAuthConfig(upstream.id);
			expect(oauth?.status).toBe('error');
			expect(oauth?.lastError).toContain('[redacted]');
			expect(oauth?.lastError).not.toContain(GENERIC_ERROR_SENTINEL);

			const audits = listAudit({ targetId: upstream.id });
			expect(JSON.stringify(audits)).not.toContain(GENERIC_ERROR_SENTINEL);
			const failure = listAudit({ action: 'oauth.connect.failure', targetId: upstream.id });
			expect(failure).toHaveLength(1);
			expect(failure[0]?.meta).toEqual({ code: 'oauth_failed' });
			expect(failure[0]?.actorId).toBe(adminId);
		} finally {
			fake.stop();
		}
	});

	for (const authorizationEndpoint of [
		'http://evil.example.test/authorize',
		'ftp://127.0.0.1/authorize'
	]) {
		test(`refuses an unsafe authorization URL: ${authorizationEndpoint}`, async () => {
			const fake = startFakeAuthServer({ authorizationEndpoint });
			try {
				const upstream = seedOAuthUpstream(`${fake.origin}/mcp`);
				const redirect = expectRedirect(
					(await callAction('oauthStart', upstream.slug, admin)).thrown
				);

				expect(redirect.location.startsWith(authorizationEndpoint)).toBe(false);
				const location = new URL(redirect.location, PUBLIC_URL);
				expect(location.pathname).toBe(`/admin/upstreams/${upstream.slug}`);
				expect(location.searchParams.get('oauthError')).toBe('invalid_authorization_url');
				expect(getOAuthConfig(upstream.id)?.status).toBe('error');
			} finally {
				fake.stop();
			}
		});
	}
});
