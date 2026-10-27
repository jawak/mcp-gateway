/**
 * The OAuth panel on the upstream detail page (datadog-mcp-oauth todo 12).
 *
 * The load must project only non-secret OAuth state, and the panel must render
 * it for every dashboard role while exposing the Connect/Disconnect actions to
 * admins only. A serialized payload is scanned for every credential sentinel so
 * a future refactor cannot quietly start forwarding a token reference.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { resetConfigCache } from '../../src/lib/server/config';
import { getDb, useDatabaseForTests, type Db } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { users } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import { createUpstream, ensureLoaded } from '../../src/lib/server/registry';
import { load } from '../../src/routes/admin/upstreams/[slug]/+page.server';
import {
	buildOAuthView,
	normalizeOAuthStatus,
	redactLastError,
	truncateClientId
} from '../../src/lib/server/upstream/oauth/view';
import {
	oauthTokenName,
	saveTokenSecret,
	upsertOAuthConfig
} from '../../src/lib/server/upstream/oauth/store';

const PUBLIC_URL = 'https://gateway.example.test';
const REDIRECT_URI = `${PUBLIC_URL}/oauth/callback`;
const ADMIN_EMAIL = 'admin@example.test';
const VIEWER_EMAIL = 'viewer@example.test';
const CLIENT_ID = 'dd-client-0123456789abcdefghijklmnopqrstuvwxyz';
const EXPIRES_AT = '2026-10-27T18:30:00.000Z';
const CONNECTED_AT = '2026-10-27T17:30:00.000Z';
const ACCESS_SENTINEL = 'SENTINEL-ACCESS-TOKEN-VALUE';
const REFRESH_SENTINEL = 'SENTINEL-REFRESH-TOKEN-VALUE';
const CLIENT_SECRET_SENTINEL = 'SENTINEL-CLIENT-SECRET-VALUE';
const ERROR_SENTINEL = 'SENTINEL-TOKEN-IN-ERROR';

let dir: string;
let db: Db;
let adminId: string;
let viewerId: string;

type Locals = {
	user: { id: string; email: string; role: 'admin' | 'viewer'; status: 'active' } | null;
	sessionId: string | null;
};

type DetailLoad = (event: { params: { slug: string }; locals: Locals }) => Promise<{
	authMode: string;
	oauth: {
		status: string;
		clientId: string | null;
		scopes: string | null;
		expiresAt: string | null;
		connectedAt: string | null;
		connectedBy: string | null;
		lastError: string | null;
		redirectUri: string;
		canManage: boolean;
	} | null;
	secrets: Array<{ name: string }>;
}>;

const detailLoad = load as unknown as DetailLoad;

function localsFor(id: string, email: string, role: 'admin' | 'viewer'): Locals {
	return { user: { id, email, role, status: 'active' }, sessionId: null };
}

function createUser(email: string, role: 'admin' | 'viewer'): string {
	const id = uuidv7();
	db.insert(users).values({ id, email, passwordHash: 'synthetic-not-a-real-hash', role }).run();
	return id;
}

function seedOAuthUpstream(): string {
	const slug = `dd-detail-${uuidv7().slice(-8)}`;
	const created = createUpstream(
		{
			slug,
			name: 'Datadog',
			transport: 'http',
			connection: { url: 'https://mcp.example.test/mcp', authMode: 'oauth' }
		},
		db
	);
	upsertOAuthConfig(
		created.id,
		{
			status: 'connected',
			clientId: CLIENT_ID,
			scopes: 'mcp_all',
			expiresAt: EXPIRES_AT,
			connectedAt: CONNECTED_AT,
			connectedBy: adminId,
			lastError: `authorization failed: access_token=${ERROR_SENTINEL}`,
			accessTokenRef: oauthTokenName(created.slug, 'access'),
			refreshTokenRef: oauthTokenName(created.slug, 'refresh'),
			clientSecretRef: oauthTokenName(created.slug, 'client_secret')
		},
		db
	);
	saveTokenSecret(oauthTokenName(created.slug, 'access'), ACCESS_SENTINEL, db);
	saveTokenSecret(oauthTokenName(created.slug, 'refresh'), REFRESH_SENTINEL, db);
	saveTokenSecret(oauthTokenName(created.slug, 'client_secret'), CLIENT_SECRET_SENTINEL, db);
	return created.slug;
}

function seedDisconnectedOAuthUpstream(): string {
	const slug = `dd-disconnected-${uuidv7().slice(-8)}`;
	createUpstream(
		{
			slug,
			name: 'Datadog (not connected)',
			transport: 'http',
			connection: { url: 'https://mcp.example.test/mcp', authMode: 'oauth' }
		},
		db
	);
	return slug;
}

function seedStaticUpstream(): string {
	const slug = `static-${uuidv7().slice(-8)}`;
	createUpstream(
		{
			slug,
			name: 'Static upstream',
			transport: 'http',
			connection: { url: 'https://static.example.test/mcp', authMode: 'none' }
		},
		db
	);
	return slug;
}

async function renderDetail(data: unknown): Promise<string> {
	const renderDir = mkdtempSync(path.join(process.cwd(), '.render-oauth-detail-'));
	try {
		const sources: Record<string, string> = {
			'Badge.svelte': 'src/lib/ui/Badge.svelte',
			'Button.svelte': 'src/lib/ui/Button.svelte',
			'Card.svelte': 'src/lib/ui/Card.svelte',
			'Page.svelte': 'src/routes/admin/upstreams/[slug]/+page.svelte'
		};
		for (const [out, source] of Object.entries(sources)) {
			const filename = path.join(process.cwd(), source);
			const { js } = compile(readFileSync(filename, 'utf8'), {
				generate: 'server',
				runes: true,
				filename
			});
			const code = js.code
				.replaceAll('$app/state', './app-state.js')
				.replaceAll('$app/paths', './app-paths.js')
				.replaceAll('$app/forms', './app-forms.js')
				.replaceAll('$lib/ui/Badge.svelte', './Badge.js')
				.replaceAll('$lib/ui/Button.svelte', './Button.js')
				.replaceAll('$lib/ui/Card.svelte', './Card.js');
			writeFileSync(path.join(renderDir, out.replace('.svelte', '.js')), code);
		}

		writeFileSync(
			path.join(renderDir, 'app-state.js'),
			"export const page = { url: new URL('http://localhost/admin/upstreams/dd') };"
		);
		writeFileSync(path.join(renderDir, 'app-paths.js'), 'export const resolve = (p) => p;');
		writeFileSync(path.join(renderDir, 'app-forms.js'), 'export const enhance = () => {};');
		writeFileSync(
			path.join(renderDir, 'tokens.js'),
			`export const HEALTH_LABEL = { healthy: 'Healthy', degraded: 'Degraded', down: 'Down', unconfigured: 'Not configured', unknown: 'Unknown' };
			 export const HEALTH_CLASSES = { healthy: '', degraded: '', down: '', unconfigured: '', unknown: '' };
			 export const HEALTH_DOT = { healthy: '', degraded: '', down: '', unconfigured: '', unknown: '' };
			 export const asHealth = (v) => (v === 'healthy' || v === 'degraded' || v === 'down' || v === 'unconfigured' ? v : 'unknown');`
		);

		const page = await import(
			`${pathToFileURL(path.join(renderDir, 'Page.js')).href}?v=${Date.now()}`
		);
		const { body } = render(page.default, { props: { data, form: {} } });
		return body;
	} finally {
		rmSync(renderDir, { recursive: true, force: true });
	}
}

function renderData(slug: string, oauth: unknown) {
	return {
		record: {
			id: 'upstream-id',
			slug,
			name: 'Datadog',
			transport: 'http',
			pin: 'lazy',
			enabled: true,
			toolsCount: 0,
			timeoutMs: 30_000,
			envRefs: {},
			connection: { url: 'https://mcp.example.test/mcp', authMode: 'oauth' },
			status: null,
			caps: null
		},
		scopes: [],
		secrets: [],
		problems: [],
		authMode: 'oauth',
		oauth,
		effectiveStatus: 'unknown',
		effectiveError: null,
		history: []
	};
}

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-detail-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '3'.repeat(64);
	process.env.MCPGW_PUBLIC_URL = PUBLIC_URL;
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	db = getDb();
	ensureLoaded(db);
	adminId = createUser(ADMIN_EMAIL, 'admin');
	viewerId = createUser(VIEWER_EMAIL, 'viewer');
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	resetConfigCache();
});

describe('oauth view helper', () => {
	test('defaults an absent row to disconnected and never invents values', () => {
		expect(normalizeOAuthStatus(undefined)).toBe('disconnected');
		expect(normalizeOAuthStatus('bogus')).toBe('disconnected');
		const view = buildOAuthView({
			config: undefined,
			connectedByEmail: null,
			canManage: false,
			redirectUri: REDIRECT_URI
		});
		expect(view).toEqual({
			status: 'disconnected',
			clientId: null,
			scopes: null,
			expiresAt: null,
			connectedAt: null,
			connectedBy: null,
			lastError: null,
			redirectUri: REDIRECT_URI,
			canManage: false
		});
	});

	test('truncates a long public client id and redacts credential-shaped errors', () => {
		const shortened = truncateClientId(CLIENT_ID);
		expect(shortened).not.toBe(CLIENT_ID);
		expect(shortened).toContain('…');
		expect(shortened!.length).toBeLessThan(CLIENT_ID.length);
		expect(truncateClientId('short-id')).toBe('short-id');
		expect(truncateClientId('  ')).toBeNull();

		const redacted = redactLastError(`exchange failed: refresh_token=${REFRESH_SENTINEL}`);
		expect(redacted).toContain('[redacted]');
		expect(redacted).not.toContain(REFRESH_SENTINEL);
		expect(redactLastError('')).toBeNull();
	});
});

describe('the upstream detail load: oauth projection', () => {
	test('an OAuth upstream returns only the safe shape and resolves connectedBy to an email', async () => {
		const slug = seedOAuthUpstream();
		const data = await detailLoad({
			params: { slug },
			locals: localsFor(adminId, ADMIN_EMAIL, 'admin')
		});

		expect(data.authMode).toBe('oauth');
		expect(data.oauth).not.toBeNull();
		expect(data.oauth?.status).toBe('connected');
		expect(data.oauth?.scopes).toBe('mcp_all');
		expect(data.oauth?.expiresAt).toBe(EXPIRES_AT);
		expect(data.oauth?.connectedAt).toBe(CONNECTED_AT);
		expect(data.oauth?.connectedBy).toBe(ADMIN_EMAIL);
		expect(data.oauth?.redirectUri).toBe(REDIRECT_URI);
		expect(data.oauth?.canManage).toBe(true);
		expect(data.oauth?.clientId).not.toBe(CLIENT_ID);
		expect(data.oauth?.clientId).toContain('…');
		expect(data.oauth?.lastError).toContain('[redacted]');
	});

	test('the serialized payload contains no token value, secret value, or oauth secret reference', async () => {
		const slug = seedOAuthUpstream();
		const data = await detailLoad({
			params: { slug },
			locals: localsFor(viewerId, VIEWER_EMAIL, 'viewer')
		});
		const payload = JSON.stringify(data);

		for (const sentinel of [
			ACCESS_SENTINEL,
			REFRESH_SENTINEL,
			CLIENT_SECRET_SENTINEL,
			ERROR_SENTINEL
		]) {
			expect(payload).not.toContain(sentinel);
		}
		for (const key of [
			'accessTokenRef',
			'refreshTokenRef',
			'clientSecretRef',
			'verifierSealed',
			'discovery'
		]) {
			expect(payload).not.toContain(key);
		}
		expect(data.secrets.some((secret) => secret.name === oauthTokenName(slug, 'access'))).toBe(
			false
		);
		expect(data.secrets.some((secret) => secret.name === oauthTokenName(slug, 'refresh'))).toBe(
			false
		);
		expect(
			data.secrets.some((secret) => secret.name === oauthTokenName(slug, 'client_secret'))
		).toBe(false);
	});

	test('an OAuth upstream with no row defaults to disconnected and cannot manage as a viewer', async () => {
		const slug = seedDisconnectedOAuthUpstream();
		const data = await detailLoad({
			params: { slug },
			locals: localsFor(viewerId, VIEWER_EMAIL, 'viewer')
		});

		expect(data.oauth?.status).toBe('disconnected');
		expect(data.oauth?.expiresAt).toBeNull();
		expect(data.oauth?.connectedAt).toBeNull();
		expect(data.oauth?.connectedBy).toBeNull();
		expect(data.oauth?.lastError).toBeNull();
		expect(data.oauth?.redirectUri).toBe(REDIRECT_URI);
		expect(data.oauth?.canManage).toBe(false);
	});

	test('a static upstream returns oauth: null', async () => {
		const slug = seedStaticUpstream();
		const data = await detailLoad({
			params: { slug },
			locals: localsFor(adminId, ADMIN_EMAIL, 'admin')
		});

		expect(data.authMode).toBe('none');
		expect(data.oauth).toBeNull();
	});

	test('an OAuth upstream resolves a missing connected_by user to null', async () => {
		const slug = seedDisconnectedOAuthUpstream();
		const created = await detailLoad({
			params: { slug },
			locals: localsFor(adminId, ADMIN_EMAIL, 'admin')
		});
		expect(created.oauth?.connectedBy).toBeNull();
	});
});

describe('the rendered OAuth panel', () => {
	test('renders the redirect URI, status, scope, and admin Connect/Disconnect controls', async () => {
		const slug = seedOAuthUpstream();
		const data = await detailLoad({
			params: { slug },
			locals: localsFor(adminId, ADMIN_EMAIL, 'admin')
		});
		const body = await renderDetail(renderData(slug, data.oauth));

		expect(body).toContain('id="oauth"');
		expect(body).toContain(REDIRECT_URI);
		expect(body).toContain('Connected');
		expect(body).toContain('mcp_all');
		expect(body).toContain('?/oauthStart');
		expect(body).toContain('?/oauthDisconnect');
		expect(body).toContain('Disconnect');
		expect(body).not.toContain(ACCESS_SENTINEL);
		expect(body).not.toContain(REFRESH_SENTINEL);
		expect(body).not.toContain(CLIENT_SECRET_SENTINEL);
	});

	test('a disconnected admin sees a Connect affordance and no expiry or disconnect form', async () => {
		const oauth = buildOAuthView({
			config: { status: 'disconnected', scopes: 'mcp_all' },
			connectedByEmail: null,
			canManage: true,
			redirectUri: REDIRECT_URI
		});
		const body = await renderDetail(renderData('dd-disconnected', oauth));

		expect(body).toContain('Disconnected');
		expect(body).toContain('Connect');
		expect(body).toContain('?/oauthStart');
		expect(body).not.toContain('?/oauthDisconnect');
		expect(body).not.toContain('Expires');
	});

	test('a viewer sees the panel but no action buttons', async () => {
		const oauth = buildOAuthView({
			config: { status: 'connected', scopes: 'mcp_all', expiresAt: EXPIRES_AT },
			connectedByEmail: ADMIN_EMAIL,
			canManage: false,
			redirectUri: REDIRECT_URI
		});
		const body = await renderDetail(renderData('dd-viewer', oauth));

		expect(body).toContain('id="oauth"');
		expect(body).toContain(REDIRECT_URI);
		expect(body).toContain('Connected');
		expect(body).toContain('mcp_all');
		expect(body).toContain(ADMIN_EMAIL);
		expect(body).not.toContain('?/oauthStart');
		expect(body).not.toContain('?/oauthDisconnect');
	});

	test('renders the redacted last error but never the sentinel', async () => {
		const oauth = buildOAuthView({
			config: {
				status: 'error',
				lastError: `exchange failed: access_token=${ERROR_SENTINEL}`
			},
			connectedByEmail: null,
			canManage: true,
			redirectUri: REDIRECT_URI
		});
		const body = await renderDetail(renderData('dd-error', oauth));

		expect(body).toContain('Last error');
		expect(body).toContain('[redacted]');
		expect(body).not.toContain(ERROR_SENTINEL);
	});
});
