/**
 * Manifest round-trip for OAuth upstreams: configuration travels, credentials do not.
 *
 * The manifest is a git-friendly description of the gateway. An OAuth upstream is
 * only describable by its mode and scopes; client ids, discovery documents, token
 * references, sealed values and pending authorization state belong to the connect
 * flow and must never leak into a file that gets committed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { resetConfigCache } from '../../src/lib/server/config';
import { getDb, useDatabaseForTests, type Db } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { upstreams } from '../../src/lib/server/db/schema';
import { listUpstreams, reload } from '../../src/lib/server/registry';
import {
	applyManifest,
	findInlinedSecrets,
	ManifestError,
	parseManifest,
	renderManifest
} from '../../src/lib/server/registry/manifest';
import {
	createPending,
	getOAuthConfig,
	oauthTokenName,
	readTokenSecret,
	saveTokenSecret,
	upsertOAuthConfig
} from '../../src/lib/server/upstream/oauth/store';

let dir: string;
let db: Db;

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-manifest-oauth-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '7'.repeat(64);
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	db = getDb();
	reload(db);
});

afterAll(() => {
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

function oauthManifest(slug: string, scopes = 'mcp_all'): string {
	return `version: 1
upstreams:
  - slug: ${slug}
    name: Datadog
    transport: http
    url: https://mcp.example.test/mcp
    authMode: oauth
    oauth:
      scopes: ${scopes}
`;
}

function oauthManifestWith(slug: string, extra: string): string {
	return `version: 1
upstreams:
  - slug: ${slug}
    name: Datadog
    transport: http
    url: https://mcp.example.test/mcp
    authMode: oauth
${extra}
    oauth:
      scopes: mcp_all
`;
}

function upstreamId(slug: string): string {
	const row = db.select().from(upstreams).where(eq(upstreams.slug, slug)).get();
	if (!row) throw new Error(`missing upstream ${slug}`);
	return row.id;
}

describe('oauth manifest import', () => {
	test('creates a disconnected OAuth row with the manifest scopes', () => {
		const slug = 'oauth-import-fresh';
		const result = applyManifest(parseManifest(oauthManifest(slug, 'mcp_all')));

		expect(result.added).toEqual([slug]);
		const config = getOAuthConfig(upstreamId(slug), db);
		expect(config?.status).toBe('disconnected');
		expect(config?.scopes).toBe('mcp_all');
		expect(config?.clientId).toBeNull();
		expect(config?.accessTokenRef).toBeNull();
		expect(config?.refreshTokenRef).toBeNull();
	});
});

describe('oauth manifest export', () => {
	test('writes authMode and scopes but no client id, tokens, secret names, pending state, or discovery', () => {
		const slug = 'oauth-export-safe';
		applyManifest(parseManifest(oauthManifest(slug)));
		const id = upstreamId(slug);

		const accessName = oauthTokenName(slug, 'access');
		const refreshName = oauthTokenName(slug, 'refresh');
		const clientSecretName = oauthTokenName(slug, 'client_secret');
		saveTokenSecret(accessName, 'SENTINEL-ACCESS-TOKEN', db);
		saveTokenSecret(refreshName, 'SENTINEL-REFRESH-TOKEN', db);
		saveTokenSecret(clientSecretName, 'SENTINEL-CLIENT-SECRET', db);
		upsertOAuthConfig(
			id,
			{
				status: 'connected',
				clientId: 'SENTINEL-CLIENT-ID',
				clientSecretRef: clientSecretName,
				accessTokenRef: accessName,
				refreshTokenRef: refreshName,
				discovery: { token_endpoint: 'https://auth.example.test/token' }
			},
			db
		);
		createPending(
			{
				state: 'SENTINEL-PENDING-STATE',
				upstreamId: id,
				redirectUri: 'https://gateway.example.test/oauth/callback',
				ttlMs: 600_000
			},
			db
		);

		const text = renderManifest(db);
		const parsed = parseManifest(text);
		const exported = parsed.upstreams.find((upstream) => upstream.slug === slug);

		expect(exported?.authMode).toBe('oauth');
		expect(exported?.oauth?.scopes).toBe('mcp_all');
		expect(findInlinedSecrets(parsed)).toEqual([]);

		for (const credential of [
			'SENTINEL-CLIENT-ID',
			'SENTINEL-ACCESS-TOKEN',
			'SENTINEL-REFRESH-TOKEN',
			'SENTINEL-CLIENT-SECRET',
			'SENTINEL-PENDING-STATE',
			accessName,
			refreshName,
			clientSecretName,
			'https://auth.example.test/token',
			'token_endpoint'
		]) {
			expect(text).not.toContain(credential);
		}
	});
});

describe('oauth manifest idempotence', () => {
	test('re-importing an identical manifest leaves a connected upstream and its tokens untouched', () => {
		const slug = 'oauth-reconnect';
		applyManifest(parseManifest(oauthManifest(slug)));
		const id = upstreamId(slug);

		const accessName = oauthTokenName(slug, 'access');
		saveTokenSecret(accessName, 'still-the-same-access-token', db);
		upsertOAuthConfig(
			id,
			{
				status: 'connected',
				clientId: 'client-stays',
				accessTokenRef: accessName,
				expiresAt: '2030-01-01T00:00:00.000Z',
				grantedScope: 'mcp_all'
			},
			db
		);
		const before = getOAuthConfig(id, db);
		const tokenBefore = readTokenSecret(accessName, db);

		const result = applyManifest(parseManifest(oauthManifest(slug)));

		expect(result.updated).toEqual([]);
		expect(result.unchanged).toContain(slug);
		const after = getOAuthConfig(id, db);
		expect(after?.status).toBe('connected');
		expect(after?.clientId).toBe('client-stays');
		expect(after?.accessTokenRef).toBe(before?.accessTokenRef);
		expect(after?.expiresAt).toBe(before?.expiresAt);
		expect(after?.grantedScope).toBe('mcp_all');
		expect(readTokenSecret(accessName, db)).toBe(tokenBefore);
	});
});

describe('oauth manifest validation', () => {
	test('rejects authMode oauth without scopes and writes nothing', () => {
		const before = listUpstreams().length;
		const invalid = `version: 1
upstreams:
  - slug: oauth-no-scopes
    name: Datadog
    transport: http
    url: https://mcp.example.test/mcp
    authMode: oauth
`;

		expect(() => applyManifest(parseManifest(invalid))).toThrow(ManifestError);
		expect(() => parseManifest(invalid)).toThrow(/oauth/i);
		expect(listUpstreams().length).toBe(before);
		expect(
			db.select().from(upstreams).where(eq(upstreams.slug, 'oauth-no-scopes')).get()
		).toBeUndefined();
	});

	const conflicts = [
		{ label: 'authStyle bearer', extra: '    authStyle: bearer', field: 'authStyle "bearer"' },
		{ label: 'authStyle header', extra: '    authStyle: header', field: 'authStyle "header"' },
		{ label: 'a non-empty authRef', extra: '    authRef: secret:datadog_token', field: 'authRef' },
		{
			label: 'a non-empty headersRef',
			extra: '    headersRef: secret:datadog_headers',
			field: 'headersRef'
		}
	] as const;

	for (const { label, extra, field } of conflicts) {
		test(`rejects authMode oauth combined with ${label} and writes nothing`, () => {
			const slug = `oauth-conflict-${field.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
			const before = listUpstreams().length;
			const text = oauthManifestWith(slug, extra);

			let error: unknown;
			try {
				parseManifest(text);
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(ManifestError);
			const issues = (error as ManifestError).issues.join('\n');
			expect(issues).toContain('upstreams.0.authMode');
			expect(issues).toContain(field);
			expect(listUpstreams().length).toBe(before);
			expect(db.select().from(upstreams).where(eq(upstreams.slug, slug)).get()).toBeUndefined();
		});
	}

	test('accepts authStyle none with no credential references for oauth', () => {
		const slug = 'oauth-style-none';
		const result = applyManifest(parseManifest(oauthManifestWith(slug, '    authStyle: none')));

		expect(result.added).toEqual([slug]);
		const config = getOAuthConfig(upstreamId(slug), db);
		expect(config?.status).toBe('disconnected');
		expect(config?.scopes).toBe('mcp_all');
	});
});

describe('static manifest round-trip', () => {
	test('export → import → export is byte-identical', () => {
		const first = renderManifest(db);
		const parsed = parseManifest(first);
		const result = applyManifest(parsed);
		const second = renderManifest(db);

		expect(result.added).toEqual([]);
		expect(result.updated).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(second).toBe(first);
	});
});
