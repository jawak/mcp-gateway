/**
 * Public OAuth callback (datadog-mcp-oauth todo 14).
 *
 * The contract: a valid single-use state exchanges the code exactly once and
 * records the consenting admin; every other state outcome is a generic 400
 * with no token call; an authorization error consumes the pending row and
 * redirects with a safe code; a session that did not start the flow gets 403.
 * No code, state, or token may appear in the Location or the audit trail.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import { resetConfigCache } from '../../src/lib/server/config';
import { getDb, useDatabaseForTests, type Db } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { upstreamOauthPending, users } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import { createUpstream, ensureLoaded } from '../../src/lib/server/registry';
import { decideAccess } from '../../src/lib/server/governance/rbac';
import { secretExists } from '../../src/lib/server/governance/secrets';
import { listAudit } from '../../src/lib/server/observability/audit';
import {
	consumePending,
	createPending,
	getOAuthConfig,
	getPending,
	oauthTokenName,
	readTokenSecret,
	upsertOAuthConfig
} from '../../src/lib/server/upstream/oauth/store';
import { actions } from '../../src/routes/admin/upstreams/[slug]/+page.server';
import { GET } from '../../src/routes/oauth/callback/+server';
import { startOAuthFixture, type OAuthFixture } from '../fixtures/oauth-server';

const PUBLIC_URL = 'https://gateway.example.test';
const REDIRECT_URI = `${PUBLIC_URL}/oauth/callback`;
const ADMIN_EMAIL = 'admin@example.test';
const VIEWER_EMAIL = 'viewer@example.test';

let dir: string;
let db: Db;
let fixture: OAuthFixture;
let adminId: string;
let viewerId: string;

type Role = 'admin' | 'viewer';
type Locals = {
	user: { id: string; email: string; role: Role; status: 'active' } | null;
	sessionId: string | null;
};
type Upstream = { id: string; slug: string };

const adminUser = { id: '', email: ADMIN_EMAIL, role: 'admin' as const, status: 'active' as const };
const viewerUser = {
	id: '',
	email: VIEWER_EMAIL,
	role: 'viewer' as const,
	status: 'active' as const
};
const admin: Locals = { user: adminUser, sessionId: null };
const viewer: Locals = { user: viewerUser, sessionId: null };

function createUser(email: string, role: Role): string {
	const id = uuidv7();
	db.insert(users).values({ id, email, passwordHash: 'synthetic-not-a-real-hash', role }).run();
	return id;
}

function seedOAuthUpstream(): Upstream {
	const slug = `dd-callback-${uuidv7().slice(-8)}`;
	const created = createUpstream(
		{
			slug,
			name: 'Datadog',
			transport: 'http',
			connection: { url: fixture.mcpUrl, authMode: 'oauth' }
		},
		db
	);
	upsertOAuthConfig(created.id, { status: 'disconnected', scopes: 'mcp_all' }, db);
	return { id: created.id, slug: created.slug };
}

async function callAction(name: 'oauthStart', slug: string): Promise<unknown> {
	const request = new Request(`http://localhost/admin/upstreams/${slug}?/${name}`, {
		method: 'POST',
		body: new FormData()
	});
	try {
		return await actions[name]({
			params: { slug },
			request,
			locals: admin,
			getClientAddress: () => '203.0.113.9'
		} as never);
	} catch (thrown) {
		return thrown;
	}
}

function expectRedirect(thrown: unknown): { status: number; location: string } {
	expect(isRedirect(thrown)).toBe(true);
	const redirect = thrown as { status: number; location: string };
	expect(redirect.status).toBe(303);
	return redirect;
}

function expectHttpError(thrown: unknown, status: number): void {
	expect(isHttpError(thrown, status)).toBe(true);
}

async function startPending(upstream: Upstream): Promise<string> {
	const thrown = await callAction('oauthStart', upstream.slug);
	const redirect = expectRedirect(thrown);
	return new URL(redirect.location).searchParams.get('state') as string;
}

async function startAuthorizedFlow(upstream: Upstream): Promise<{ state: string; code: string }> {
	const thrown = await callAction('oauthStart', upstream.slug);
	const redirect = expectRedirect(thrown);
	const authorize = await fetch(redirect.location, { redirect: 'manual' });
	expect(authorize.status).toBe(302);
	const callback = new URL(authorize.headers.get('location') as string);
	return {
		state: callback.searchParams.get('state') as string,
		code: callback.searchParams.get('code') as string
	};
}

type CallbackParams = {
	state?: string;
	code?: string;
	error?: string;
	error_description?: string;
};

type CallbackResult = { thrown: unknown; response?: Response };

async function callCallback(params: CallbackParams, who: Locals['user']): Promise<CallbackResult> {
	const url = new URL('http://localhost/oauth/callback');
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, value);
	}
	try {
		const response = await GET({
			url,
			request: new Request(url),
			locals: { user: who, sessionId: null },
			getClientAddress: () => '203.0.113.7'
		} as never);
		return { thrown: undefined, response };
	} catch (thrown) {
		return { thrown };
	}
}

function pendingFor(upstreamId: string) {
	return db
		.select()
		.from(upstreamOauthPending)
		.all()
		.filter((row) => row.upstreamId === upstreamId);
}

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-callback-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '55'.repeat(32);
	process.env.MCPGW_PUBLIC_URL = PUBLIC_URL;
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	db = getDb();
	ensureLoaded(db);
	adminId = createUser(ADMIN_EMAIL, 'admin');
	viewerId = createUser(VIEWER_EMAIL, 'viewer');
	adminUser.id = adminId;
	viewerUser.id = viewerId;
	fixture = await startOAuthFixture({ refreshMode: 'reusable' });
});

afterAll(() => {
	fixture?.stop();
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('GET /oauth/callback', () => {
	test('exchanges a valid state and code exactly once, then redirects connected', async () => {
		const upstream = seedOAuthUpstream();
		const { state, code } = await startAuthorizedFlow(upstream);
		const before = fixture.requests.token;

		const { thrown } = await callCallback({ state, code }, null);
		const redirect = expectRedirect(thrown);

		expect(redirect.location).toBe(`/admin/upstreams/${upstream.slug}?connected=1`);
		expect(fixture.requests.token).toBe(before + 1);
		expect(getPending(state)).toBeUndefined();
		expect(pendingFor(upstream.id)).toHaveLength(0);

		const oauth = getOAuthConfig(upstream.id);
		expect(oauth?.status).toBe('connected');
		expect(oauth?.connectedBy).toBe(adminId);
		expect(oauth?.connectedAt).toBeString();
		expect(oauth?.lastError).toBeNull();

		const accessToken = readTokenSecret(oauthTokenName(upstream.slug, 'access'));
		if (!accessToken) throw new Error('access token was not stored');
		expect(accessToken.length).toBeGreaterThan(0);
		expect(secretExists(oauthTokenName(upstream.slug, 'access'))).toBe(true);
		expect(secretExists(oauthTokenName(upstream.slug, 'refresh'))).toBe(true);

		const audits = listAudit({ targetId: upstream.id, action: 'oauth.connect.success' });
		expect(audits).toHaveLength(1);
		expect(audits[0]?.actorType).toBe('system');
		expect(audits[0]?.meta).toMatchObject({ createdBy: adminId });

		const serializedAudits = JSON.stringify(listAudit({ targetId: upstream.id }));
		for (const secret of [code, state, accessToken]) {
			expect(redirect.location).not.toContain(secret);
			expect(serializedAudits).not.toContain(secret);
		}
	});

	test('rejects a replayed state without a second token exchange', async () => {
		const upstream = seedOAuthUpstream();
		const { state, code } = await startAuthorizedFlow(upstream);
		expectRedirect((await callCallback({ state, code }, null)).thrown);
		const afterFirst = fixture.requests.token;

		const { thrown } = await callCallback({ state, code }, null);

		expectHttpError(thrown, 400);
		expect(fixture.requests.token).toBe(afterFirst);
		expect(getPending(state)).toBeUndefined();
	});

	test('rejects an expired state, deletes it, and never calls the token endpoint', async () => {
		const upstream = seedOAuthUpstream();
		const state = `expired-${uuidv7()}`;
		createPending(
			{
				state,
				upstreamId: upstream.id,
				redirectUri: REDIRECT_URI,
				createdBy: adminId,
				ttlMs: -1_000
			},
			db
		);
		const before = fixture.requests.token;

		const { thrown } = await callCallback({ state, code: 'irrelevant-code' }, null);

		expectHttpError(thrown, 400);
		expect(fixture.requests.token).toBe(before);
		expect(getPending(state)).toBeUndefined();
	});

	test('rejects an unknown state without a token exchange', async () => {
		const state = `unknown-${uuidv7()}`;
		const before = fixture.requests.token;

		const { thrown } = await callCallback({ state, code: 'irrelevant-code' }, null);

		expectHttpError(thrown, 400);
		expect(fixture.requests.token).toBe(before);
		expect(getPending(state)).toBeUndefined();
	});

	test('consumes the pending flow and redirects safely on access_denied', async () => {
		const upstream = seedOAuthUpstream();
		const state = await startPending(upstream);
		const descriptionSentinel = 'SENTINEL-ERROR-DESCRIPTION-TOKEN';
		const before = fixture.requests.token;

		const { thrown } = await callCallback(
			{
				state,
				error: 'access_denied',
				error_description: `consent denied access_token=${descriptionSentinel}`
			},
			null
		);
		const redirect = expectRedirect(thrown);
		const location = new URL(redirect.location, PUBLIC_URL);

		expect(location.pathname).toBe(`/admin/upstreams/${upstream.slug}`);
		expect([...location.searchParams.keys()]).toEqual(['oauthError']);
		expect(location.searchParams.get('oauthError')).toBe('access_denied');
		expect(redirect.location).not.toContain(state);
		expect(redirect.location).not.toContain(descriptionSentinel);
		expect(fixture.requests.token).toBe(before);
		expect(getPending(state)).toBeUndefined();

		const oauth = getOAuthConfig(upstream.id);
		expect(oauth?.status).toBe('error');
		expect(oauth?.lastError).toContain('[redacted]');
		expect(oauth?.lastError).not.toContain(descriptionSentinel);

		const audits = listAudit({ targetId: upstream.id, action: 'oauth.connect.failure' });
		expect(audits).toHaveLength(1);
		expect(audits[0]?.actorType).toBe('system');
		expect(audits[0]?.meta).toMatchObject({ createdBy: adminId, code: 'access_denied' });
		const serialized = JSON.stringify(audits);
		expect(serialized).not.toContain(state);
		expect(serialized).not.toContain(descriptionSentinel);
	});

	test('returns 403 and leaves the pending flow untouched for a different session', async () => {
		const upstream = seedOAuthUpstream();
		const state = await startPending(upstream);
		const before = fixture.requests.token;

		const { thrown } = await callCallback({ state, code: 'irrelevant-code' }, viewer.user);

		expectHttpError(thrown, 403);
		expect(fixture.requests.token).toBe(before);
		expect(getPending(state)).toBeDefined();
		expect(pendingFor(upstream.id)).toHaveLength(1);

		consumePending(state, db);
	});
});

describe('public callback access', () => {
	test('decideAccess allows an unauthenticated GET to /oauth/callback', () => {
		expect(decideAccess({ pathname: '/oauth/callback', method: 'GET', user: null })).toEqual({
			action: 'allow'
		});
	});
});
