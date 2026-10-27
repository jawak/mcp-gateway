/**
 * Vault-backed OAuth store (datadog-mcp-oauth todo 4).
 *
 * Proves the persistence contract the OAuth provider depends on: token values
 * only exist as sealed `secret_refs`, expiry is derived once, refresh tokens
 * survive a response that omits them, pending state is single-use, and every
 * system write is audited without the value.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetConfigCache } from '../../src/lib/server/config';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { getDb, getSqlite, useDatabaseForTests } from '../../src/lib/server/db';
import { schema } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import {
	clearTokens,
	consumePending,
	createPending,
	deleteOAuthConfig,
	getOAuthConfig,
	getPending,
	oauthTokenName,
	readClientSecret,
	readTokenSecret,
	saveClientSecret,
	saveTokens,
	setOAuthStatus,
	upsertOAuthConfig
} from '../../src/lib/server/upstream/oauth/store';

const ACCESS = 'access-token-value-9f3c1b';
const REFRESH = 'refresh-token-value-7a2d4e';
const CLIENT_SECRET = 'client-secret-value-1b8e6a';

let dir: string;

type Upstream = { id: string; slug: string };

function insertUpstream(): Upstream {
	const id = uuidv7();
	const slug = `oauth-${id.slice(-8)}`;
	getDb()
		.insert(schema.upstreams)
		.values({
			id,
			slug,
			name: 'OAuth upstream',
			transport: 'http',
			connection: { url: 'https://mcp.example.test/mcp' }
		})
		.run();
	return { id, slug };
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

function auditRows(actionPrefix: string): Array<Record<string, unknown>> {
	return getSqlite()
		.prepare('select * from audit_log where action like ? order by created_at asc')
		.all(`${actionPrefix}%`) as Array<Record<string, unknown>>;
}

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-store-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '11'.repeat(32);
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

afterAll(() => {
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('oauth token secrets', () => {
	test('seals both tokens under deterministic slug-safe names', () => {
		const { id, slug } = insertUpstream();
		saveTokens(id, {
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 3600,
			scope: 'mcp_all'
		});

		const config = getOAuthConfig(id);
		expect(config).toBeDefined();
		expect(config?.accessTokenRef).toBe(`oauth_${slug}_access`);
		expect(config?.refreshTokenRef).toBe(`oauth_${slug}_refresh`);
		expect(config?.status).toBe('connected');
		expect(config?.tokenType).toBe('Bearer');
		expect(config?.grantedScope).toBe('mcp_all');
		expect(config?.lastError).toBeNull();

		const accessRow = rawSecret(`oauth_${slug}_access`);
		expect(accessRow).toBeDefined();
		expect(accessRow?.cipher).not.toContain(ACCESS);
		expect(Buffer.from(accessRow!.cipher, 'base64').toString('utf8')).not.toContain(ACCESS);
		expect(readTokenSecret(`oauth_${slug}_access`)).toBe(ACCESS);
		expect(readTokenSecret(`oauth_${slug}_refresh`)).toBe(REFRESH);
	});

	test('computes expires_at from expires_in and leaves it null when omitted', () => {
		const { id } = insertUpstream();
		const before = Date.now();
		saveTokens(id, {
			access_token: ACCESS,
			token_type: 'Bearer',
			expires_in: 3600
		});
		const expiresAt = getOAuthConfig(id)?.expiresAt;
		expect(expiresAt).not.toBeNull();
		const delta = Date.parse(expiresAt!) - before;
		expect(delta).toBeGreaterThanOrEqual(3_600_000 - 5_000);
		expect(delta).toBeLessThanOrEqual(3_600_000 + 5_000);

		const { id: noExpiry } = insertUpstream();
		saveTokens(noExpiry, { access_token: ACCESS, token_type: 'Bearer' });
		expect(getOAuthConfig(noExpiry)?.expiresAt).toBeNull();
	});

	test('preserves the existing refresh token when the response omits one', () => {
		const { id } = insertUpstream();
		saveTokens(id, {
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 60
		});
		const refreshRef = getOAuthConfig(id)?.refreshTokenRef;
		expect(refreshRef).toBeDefined();

		saveTokens(id, { access_token: 'rotated-access', token_type: 'Bearer', expires_in: 60 });
		expect(getOAuthConfig(id)?.refreshTokenRef).toBe(refreshRef!);
		expect(readTokenSecret(refreshRef!)).toBe(REFRESH);
		expect(readTokenSecret(getOAuthConfig(id)!.accessTokenRef!)).toBe('rotated-access');
	});

	test('clearTokens removes both secret rows and nulls the refs', () => {
		const { id, slug } = insertUpstream();
		saveTokens(id, {
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 3600,
			scope: 'mcp_all'
		});

		clearTokens(id);

		const config = getOAuthConfig(id);
		expect(config?.accessTokenRef).toBeNull();
		expect(config?.refreshTokenRef).toBeNull();
		expect(config?.expiresAt).toBeNull();
		expect(config?.grantedScope).toBeNull();
		expect(config?.status).toBe('error');
		expect(config?.lastError).toBe('invalid_grant');
		expect(config?.connectedAt).toBeNull();
		expect(rawSecret(`oauth_${slug}_access`)).toBeUndefined();
		expect(rawSecret(`oauth_${slug}_refresh`)).toBeUndefined();
		expect(readTokenSecret(`oauth_${slug}_access`)).toBeUndefined();
	});

	test('keeps a token secret another upstream still references', () => {
		const { id, slug } = insertUpstream();
		saveTokens(id, {
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 3600
		});
		const accessName = oauthTokenName(slug, 'access');
		getDb()
			.insert(schema.upstreams)
			.values({
				id: uuidv7(),
				slug: `ref-${uuidv7().slice(-8)}`,
				name: 'Static reference',
				transport: 'http',
				connection: {
					url: 'https://static.example.test/mcp',
					authMode: 'static',
					authRef: `secret:${accessName}`
				}
			})
			.run();

		clearTokens(id);

		expect(readTokenSecret(accessName)).toBe(ACCESS);
		expect(rawSecret(accessName)).toBeDefined();
		expect(rawSecret(oauthTokenName(slug, 'refresh'))).toBeUndefined();
		expect(getOAuthConfig(id)?.accessTokenRef).toBeNull();
		expect(getOAuthConfig(id)?.status).toBe('error');
	});
});

describe('oauth client secret', () => {
	test('seals and reads a DCR-issued client secret', () => {
		const { id, slug } = insertUpstream();
		saveClientSecret(id, CLIENT_SECRET);

		expect(getOAuthConfig(id)?.clientSecretRef).toBe(`oauth_${slug}_client_secret`);
		expect(rawSecret(`oauth_${slug}_client_secret`)?.cipher).not.toContain(CLIENT_SECRET);
		expect(readClientSecret(id)).toBe(CLIENT_SECRET);
	});
});

describe('pending authorization state', () => {
	test('is single-use: the second consume returns undefined', () => {
		const { id } = insertUpstream();
		const state = uuidv7();
		createPending({
			state,
			upstreamId: id,
			redirectUri: 'https://gateway.example.test/oauth/callback',
			ttlMs: 600_000
		});
		expect(getPending(state)?.upstreamId).toBe(id);

		expect(consumePending(state)?.state).toBe(state);
		expect(consumePending(state)).toBeUndefined();
		expect(getPending(state)).toBeUndefined();
	});

	test('rejects an expired pending row', () => {
		const { id } = insertUpstream();
		const state = uuidv7();
		createPending({
			state,
			upstreamId: id,
			redirectUri: 'https://gateway.example.test/oauth/callback',
			ttlMs: -1_000
		});

		expect(getPending(state)).toBeDefined();
		expect(consumePending(state)).toBeUndefined();
		expect(getPending(state)).toBeUndefined();
	});

	test('createPending deletes the previous flow for the same upstream', () => {
		const { id } = insertUpstream();
		const first = uuidv7();
		const second = uuidv7();
		createPending({
			state: first,
			upstreamId: id,
			redirectUri: 'https://gateway.example.test/oauth/callback',
			ttlMs: 600_000
		});
		createPending({
			state: second,
			upstreamId: id,
			redirectUri: 'https://gateway.example.test/oauth/callback',
			ttlMs: 600_000
		});

		expect(getPending(first)).toBeUndefined();
		expect(getPending(second)).toBeDefined();
	});
});

describe('oauth config row', () => {
	test('upsert patches fields and deleteOAuthConfig removes the row', () => {
		const { id } = insertUpstream();
		upsertOAuthConfig(id, { status: 'authorizing', scopes: 'mcp_all' });
		setOAuthStatus(id, 'error', { lastError: 'invalid_client' });
		expect(getOAuthConfig(id)?.status).toBe('error');
		expect(getOAuthConfig(id)?.lastError).toBe('invalid_client');

		setOAuthStatus(id, 'authorizing');
		expect(getOAuthConfig(id)?.lastError).toBeNull();

		deleteOAuthConfig(id);
		expect(getOAuthConfig(id)).toBeUndefined();
	});

	test('getOAuthConfig returns undefined for an unknown upstream', () => {
		expect(getOAuthConfig(uuidv7())).toBeUndefined();
	});
});

describe('audit trail', () => {
	test('records system store/rotate/clear rows without any secret value', () => {
		const { id, slug } = insertUpstream();
		saveTokens(id, {
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 60
		});
		// A second save rotates the deterministic secret rows.
		saveTokens(id, {
			access_token: 'rotated-access-value',
			token_type: 'Bearer',
			refresh_token: 'rotated-refresh-value',
			expires_in: 60
		});
		clearTokens(id);

		const rows = auditRows('oauth.token.');
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.actor_type).toBe('system');
			expect(String(row.action)).toMatch(/^oauth\.token\.(store|rotate|clear)$/);
		}
		expect(rows.some((row) => row.action === 'oauth.token.store')).toBe(true);
		expect(rows.some((row) => row.action === 'oauth.token.rotate')).toBe(true);
		expect(rows.some((row) => row.action === 'oauth.token.clear')).toBe(true);

		const referenced = new Set(rows.map((row) => row.target_id));
		expect(referenced).toContain(`oauth_${slug}_access`);
		expect(referenced).toContain(`oauth_${slug}_refresh`);

		const dump = JSON.stringify(getSqlite().prepare('select * from audit_log').all());
		for (const value of [
			ACCESS,
			REFRESH,
			'rotated-access-value',
			'rotated-refresh-value',
			CLIENT_SECRET
		]) {
			expect(dump).not.toContain(value);
		}
	});

	test('does not audit a write that removed nothing', () => {
		const { id, slug } = insertUpstream();
		clearTokens(id);
		const rows = getSqlite()
			.prepare('select * from audit_log where target_id = ?')
			.all(`oauth_${slug}_access`) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(0);
	});
});

describe('no plaintext in the database', () => {
	test('secret_refs and upstream_oauth never contain a raw token', () => {
		const { id } = insertUpstream();
		saveTokens(id, {
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 60
		});
		saveClientSecret(id, CLIENT_SECRET);

		const secrets = JSON.stringify(getSqlite().prepare('select * from secret_refs').all());
		const oauth = JSON.stringify(getSqlite().prepare('select * from upstream_oauth').all());
		for (const value of [ACCESS, REFRESH, CLIENT_SECRET]) {
			expect(secrets).not.toContain(value);
			expect(oauth).not.toContain(value);
		}
	});
});
