/**
 * OAuth cleanup on mode switch, upstream delete, secret guard, and retention
 * (datadog-mcp-oauth todo 10).
 *
 * The contract these tests lock:
 *   - leaving `authMode: 'oauth'` destroys tokens, the DCR client secret, any
 *     pending flow, and the `upstream_oauth` row in the same transaction as the
 *     upstream update;
 *   - a rejected auth-mode switch mutates nothing;
 *   - deleting the upstream removes every `oauth_<slug>_*` secret before the FK
 *     cascade drops the OAuth rows;
 *   - `deleteSecret` refuses a live OAuth reference with `secret_in_use`;
 *   - expired pending flows are pruned by retention;
 *   - no plaintext token or client secret ever reaches a row or an audit entry.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { resetConfigCache } from '../../src/lib/server/config';
import { getDb, getSqlite, useDatabaseForTests, type Db } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { schema } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import { RegistryError } from '../../src/lib/server/registry';
import {
	createUpstream,
	deleteUpstream,
	updateUpstream
} from '../../src/lib/server/registry/index';
import {
	deleteSecret,
	putSecret,
	secretExists,
	secretReferencedBy
} from '../../src/lib/server/governance/secrets';
import { runRetention } from '../../src/lib/server/observability/retention';
import {
	clearOAuthConfig,
	createPending,
	getOAuthConfig,
	getPending,
	oauthTokenName,
	pruneExpiredOAuthPending,
	readClientSecret,
	readTokenSecret,
	saveClientSecret,
	saveTokenSecret,
	saveTokens,
	upsertOAuthConfig
} from '../../src/lib/server/upstream/oauth/store';
import { resolveAuthMode } from '../../src/lib/server/upstream/types';

const ACCESS = 'cleanup-access-token-4e7a91';
const REFRESH = 'cleanup-refresh-token-8b2c63';
const CLIENT_SECRET = 'cleanup-client-secret-5d1f42';
const REDIRECT_URI = 'https://gateway.example.test/oauth/callback';

let dir: string;
let db: Db;

type Seeded = {
	id: string;
	slug: string;
	accessName: string;
	refreshName: string;
	clientSecretName: string;
	state: string;
};

function createHttpUpstream(authMode: 'oauth' | 'static' | 'none'): { id: string; slug: string } {
	const slug = `oauth-${uuidv7().slice(-8)}`;
	const created = createUpstream(
		{
			slug,
			name: slug,
			transport: 'http',
			connection:
				authMode === 'static'
					? { url: 'https://mcp.example.test/mcp', authMode, authRef: 'secret:legacy-token' }
					: { url: 'https://mcp.example.test/mcp', authMode }
		},
		db
	);
	return { id: created.id, slug: created.slug };
}

function seedConnectedOAuth(): Seeded {
	const { id, slug } = createHttpUpstream('oauth');
	upsertOAuthConfig(
		id,
		{
			status: 'connected',
			clientId: 'dcr-client-123',
			scopes: 'mcp_all',
			authorizationServerUrl: 'https://auth.example.test/v1/mcp',
			resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource',
			authorizationEndpoint: 'https://auth.example.test/authorize',
			tokenEndpoint: 'https://auth.example.test/token',
			registrationEndpoint: 'https://auth.example.test/register'
		},
		db
	);
	saveTokens(
		id,
		{
			access_token: ACCESS,
			token_type: 'Bearer',
			refresh_token: REFRESH,
			expires_in: 3600,
			scope: 'mcp_all'
		},
		db
	);
	saveClientSecret(id, CLIENT_SECRET, db);
	const state = uuidv7();
	createPending({ state, upstreamId: id, redirectUri: REDIRECT_URI, ttlMs: 600_000 }, db);
	return {
		id,
		slug,
		accessName: oauthTokenName(slug, 'access'),
		refreshName: oauthTokenName(slug, 'refresh'),
		clientSecretName: oauthTokenName(slug, 'client_secret'),
		state
	};
}

function rawCount(sql: string, ...params: string[]): number {
	return (
		getSqlite()
			.prepare(sql)
			.get(...params) as { value: number }
	).value;
}

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-cleanup-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = 'a'.repeat(64);
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	db = getDb();
	putSecret('legacy-token', 'legacy-value', { db });
});

afterAll(() => {
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('oauth → static update', () => {
	test('removes token secrets, client secret, pending state and the oauth row', () => {
		const seeded = seedConnectedOAuth();

		const updated = updateUpstream(
			seeded.id,
			{
				name: 'switched to static',
				connection: {
					url: 'https://mcp.example.test/mcp',
					authMode: 'static',
					authRef: 'secret:legacy-token'
				}
			},
			db
		);

		expect(updated.name).toBe('switched to static');
		expect(resolveAuthMode(updated.connection, updated.headersRef)).toBe('static');
		expect(getOAuthConfig(seeded.id, db)).toBeUndefined();
		expect(getPending(seeded.state, db)).toBeUndefined();
		expect(readTokenSecret(seeded.accessName, db)).toBeUndefined();
		expect(readTokenSecret(seeded.refreshName, db)).toBeUndefined();
		expect(readClientSecret(seeded.id, db)).toBeUndefined();

		for (const name of [seeded.accessName, seeded.refreshName, seeded.clientSecretName]) {
			expect(rawCount('select count(*) as value from secret_refs where name = ?', name)).toBe(0);
		}
		expect(
			rawCount('select count(*) as value from upstream_oauth where upstream_id = ?', seeded.id)
		).toBe(0);
		expect(
			rawCount(
				'select count(*) as value from upstream_oauth_pending where upstream_id = ?',
				seeded.id
			)
		).toBe(0);
	});

	test('keeps the oauth.token.clear system audits without any value', () => {
		const seeded = seedConnectedOAuth();
		updateUpstream(
			seeded.id,
			{
				connection: { url: 'https://mcp.example.test/mcp', authMode: 'none' }
			},
			db
		);

		const rows = getSqlite()
			.prepare("select * from audit_log where action = 'oauth.token.clear' and target_id = ?")
			.all(seeded.accessName) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0].actor_type).toBe('system');

		const dump = JSON.stringify(getSqlite().prepare('select * from audit_log').all());
		expect(dump).not.toContain(ACCESS);
		expect(dump).not.toContain(REFRESH);
		expect(dump).not.toContain(CLIENT_SECRET);
	});

	test('a static switch without a credential is rejected and leaves oauth untouched', () => {
		const seeded = seedConnectedOAuth();

		let error: unknown;
		try {
			updateUpstream(
				seeded.id,
				{ connection: { url: 'https://mcp.example.test/mcp', authMode: 'static' } },
				db
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(RegistryError);
		expect((error as RegistryError).code).toBe('invalid_auth_mode');

		const config = getOAuthConfig(seeded.id, db);
		expect(config?.status).toBe('connected');
		expect(config?.clientId).toBe('dcr-client-123');
		expect(readTokenSecret(seeded.accessName, db)).toBe(ACCESS);
		expect(readClientSecret(seeded.id, db)).toBe(CLIENT_SECRET);
		expect(getPending(seeded.state, db)).toBeDefined();

		const row = db.select().from(schema.upstreams).where(eq(schema.upstreams.id, seeded.id)).get();
		expect(resolveAuthMode(row?.connection ?? null, row?.headersRef)).toBe('oauth');
	});

	test('an unresolvable replacement ref is rejected before oauth state is destroyed', () => {
		const seeded = seedConnectedOAuth();

		let error: unknown;
		try {
			updateUpstream(
				seeded.id,
				{
					connection: {
						url: 'https://mcp.example.test/mcp',
						authMode: 'static',
						authRef: 'secret:does-not-exist'
					}
				},
				db
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(RegistryError);
		expect((error as RegistryError).code).toBe('missing_secret');
		expect(getOAuthConfig(seeded.id, db)?.status).toBe('connected');
		expect(readTokenSecret(seeded.accessName, db)).toBe(ACCESS);
		expect(readTokenSecret(seeded.refreshName, db)).toBe(REFRESH);
		expect(getPending(seeded.state, db)).toBeDefined();

		const row = db.select().from(schema.upstreams).where(eq(schema.upstreams.id, seeded.id)).get();
		expect(resolveAuthMode(row?.connection ?? null, row?.headersRef)).toBe('oauth');
	});

	test('a self-referential static authRef keeps the access secret resolvable', () => {
		const seeded = seedConnectedOAuth();
		const authRef = `secret:${seeded.accessName}`;

		const updated = updateUpstream(
			seeded.id,
			{
				connection: {
					url: 'https://mcp.example.test/mcp',
					authMode: 'static',
					authRef
				}
			},
			db
		);

		expect(resolveAuthMode(updated.connection, updated.headersRef)).toBe('static');
		expect((updated.connection as { authRef?: string }).authRef).toBe(authRef);
		expect(secretExists(authRef)).toBe(true);
		expect(readTokenSecret(seeded.accessName, db)).toBe(ACCESS);
		expect(readTokenSecret(seeded.refreshName, db)).toBeUndefined();
		expect(readClientSecret(seeded.id, db)).toBeUndefined();
		expect(getOAuthConfig(seeded.id, db)).toBeUndefined();
		expect(getPending(seeded.state, db)).toBeUndefined();
	});
});

describe('cross-upstream references', () => {
	test('keeps secrets that another upstream still references, through switch and delete', () => {
		const a = seedConnectedOAuth();
		const bSlug = `oauth-${uuidv7().slice(-8)}`;
		const b = createUpstream(
			{
				slug: bSlug,
				name: bSlug,
				transport: 'http',
				connection: {
					url: 'https://mcp.example.test/mcp',
					authMode: 'static',
					authRef: `secret:${a.accessName}`
				},
				headersRef: a.refreshName
			},
			db
		);

		updateUpstream(
			a.id,
			{ connection: { url: 'https://mcp.example.test/mcp', authMode: 'none' } },
			db
		);

		expect(secretExists(a.accessName)).toBe(true);
		expect(secretExists(a.refreshName)).toBe(true);
		expect(secretExists(a.clientSecretName)).toBe(false);
		expect(secretReferencedBy(a.accessName)).toContain(b.slug);
		expect(secretReferencedBy(a.refreshName)).toContain(b.slug);

		deleteUpstream(a.id, db);

		expect(secretExists(a.accessName)).toBe(true);
		expect(secretExists(a.refreshName)).toBe(true);
		expect(getOAuthConfig(a.id, db)).toBeUndefined();
		const row = db.select().from(schema.upstreams).where(eq(schema.upstreams.id, b.id)).get();
		expect(secretExists((row?.connection as { authRef?: string }).authRef ?? '')).toBe(true);
		expect(secretExists(row?.headersRef ?? '')).toBe(true);
	});
});

describe('upstream delete', () => {
	test('removes every oauth secret, pending row and oauth row without FK errors', () => {
		const seeded = seedConnectedOAuth();

		expect(() => deleteUpstream(seeded.id, db)).not.toThrow();

		expect(getOAuthConfig(seeded.id, db)).toBeUndefined();
		expect(getPending(seeded.state, db)).toBeUndefined();
		for (const name of [seeded.accessName, seeded.refreshName, seeded.clientSecretName]) {
			expect(rawCount('select count(*) as value from secret_refs where name = ?', name)).toBe(0);
			expect(readTokenSecret(name, db)).toBeUndefined();
		}
		expect(
			rawCount('select count(*) as value from upstream_oauth where upstream_id = ?', seeded.id)
		).toBe(0);
		expect(
			rawCount(
				'select count(*) as value from upstream_oauth_pending where upstream_id = ?',
				seeded.id
			)
		).toBe(0);
		expect(rawCount('select count(*) as value from upstreams where id = ?', seeded.id)).toBe(0);
	});
});

describe('deleteSecret guard', () => {
	test('refuses each live oauth reference with secret_in_use', () => {
		const seeded = seedConnectedOAuth();

		for (const name of [seeded.accessName, seeded.refreshName, seeded.clientSecretName]) {
			let error: unknown;
			try {
				deleteSecret(name, { db });
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(RegistryError);
			expect((error as RegistryError).code).toBe('secret_in_use');
			expect(rawCount('select count(*) as value from secret_refs where name = ?', name)).toBe(1);
		}

		clearOAuthConfig(seeded.id, db);

		for (const name of [seeded.accessName, seeded.refreshName, seeded.clientSecretName]) {
			saveTokenSecret(name, 'replacement-after-disconnect', db);
			expect(() => deleteSecret(name, { db })).not.toThrow();
			expect(rawCount('select count(*) as value from secret_refs where name = ?', name)).toBe(0);
		}
	});
});

describe('retention', () => {
	test('prunes only expired pending rows and returns the count', () => {
		const expired = createHttpUpstream('oauth');
		const live = createHttpUpstream('oauth');

		const insertPending = (upstreamId: string, expiresAt: string) => {
			const state = uuidv7();
			db.insert(schema.upstreamOauthPending)
				.values({
					state,
					upstreamId,
					verifierSealed: JSON.stringify({ cipher: 'c', iv: 'i', tag: 't', keyVer: 1 }),
					redirectUri: REDIRECT_URI,
					createdBy: null,
					createdAt: new Date().toISOString(),
					expiresAt
				})
				.run();
			return state;
		};

		const expiredState = insertPending(expired.id, new Date(Date.now() - 60_000).toISOString());
		const liveState = insertPending(live.id, new Date(Date.now() + 600_000).toISOString());

		expect(pruneExpiredOAuthPending(db)).toBe(1);
		expect(getPending(expiredState, db)).toBeUndefined();
		expect(getPending(liveState, db)).toBeDefined();
	});

	test('runRetention includes oauthPending', () => {
		const { id } = createHttpUpstream('oauth');
		const state = uuidv7();
		db.insert(schema.upstreamOauthPending)
			.values({
				state,
				upstreamId: id,
				verifierSealed: JSON.stringify({ cipher: 'c', iv: 'i', tag: 't', keyVer: 1 }),
				redirectUri: REDIRECT_URI,
				createdBy: null,
				createdAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() - 60_000).toISOString()
			})
			.run();

		const result = runRetention(db);
		expect(result).toHaveProperty('oauthPending');
		expect(result.oauthPending).toBe(1);
		expect(getPending(state, db)).toBeUndefined();
	});
});

describe('no orphan or plaintext oauth material', () => {
	test('cleanup leaves no oauth_* rows and no value in any row or audit entry', () => {
		const seeded = seedConnectedOAuth();
		updateUpstream(
			seeded.id,
			{ connection: { url: 'https://mcp.example.test/mcp', authMode: 'none' } },
			db
		);

		const orphans = getSqlite()
			.prepare("select name from secret_refs where name like 'oauth_%' and name like ?")
			.all(`%${seeded.slug}%`) as Array<{ name: string }>;
		expect(orphans).toHaveLength(0);

		const dump = JSON.stringify({
			secrets: getSqlite().prepare('select * from secret_refs').all(),
			oauth: getSqlite().prepare('select * from upstream_oauth').all(),
			pending: getSqlite().prepare('select * from upstream_oauth_pending').all(),
			audit: getSqlite().prepare('select * from audit_log').all()
		});
		expect(dump).not.toContain(ACCESS);
		expect(dump).not.toContain(REFRESH);
		expect(dump).not.toContain(CLIENT_SECRET);
		expect(dump).not.toContain('replacement-after-disconnect');
	});
});
