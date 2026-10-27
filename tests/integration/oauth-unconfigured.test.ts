/**
 * OAuth authorization-required mapping through the connection test, health, and
 * the dashboard data (datadog-mcp-oauth todo 9).
 *
 * An OAuth upstream that has not completed consent must be reported as
 * `unconfigured` with an actionable Connect hint. It must never spawn a scratch
 * pool, contact the MCP or token endpoint, launch a browser, or enter the
 * `down`/backoff/restart path that a transient outage uses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { resetConfigCache } from '../../src/lib/server/config';
import { getDb, useDatabaseForTests, type Db } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { upstreamHealth, upstreams } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import { createUpstream, getSnapshot } from '../../src/lib/server/registry/index';
import { load as loadList } from '../../src/routes/admin/upstreams/+page.server';
import { load as loadDetail } from '../../src/routes/admin/upstreams/[slug]/+page.server';
import { testUpstream } from '../../src/lib/server/governance/upstream-test';
import { HealthMonitor } from '../../src/lib/server/upstream/health';
import { UpstreamPool } from '../../src/lib/server/upstream/pool';
import {
	createOAuthProvider,
	OAuthAuthorizationRequiredError,
	type OAuthProvider
} from '../../src/lib/server/upstream/oauth/provider';
import { getOAuthConfig, saveTokenSecret } from '../../src/lib/server/upstream/oauth/store';
import {
	UnconfiguredUpstreamError,
	type UpstreamRecord
} from '../../src/lib/server/upstream/types';
import { startOAuthFixture, type OAuthFixture } from '../fixtures/oauth-server';

const PUBLIC_URL = new URL('https://gateway.example.test');
const CONNECT_MESSAGE = 'OAuth authorization required — click Connect';

let dir: string;
let db: Db;
let fixture: OAuthFixture;

type Seeded = { id: string; slug: string; record: UpstreamRecord };

type ListRow = { slug: string; status: string; error: string | null; authMode: string };

const listLoad = loadList as unknown as () => { rows: ListRow[] };
const detailLoad = loadDetail as unknown as (event: { params: { slug: string } }) => Promise<{
	effectiveStatus: string;
	effectiveError: string | null;
	authMode: string;
	history: Array<{ status: string }>;
}>;

function insertOAuthUpstream(): Seeded {
	const slug = `oauth-unconf-${uuidv7().slice(-8)}`;
	const created = createUpstream(
		{
			slug,
			name: slug,
			transport: 'http',
			connection: { url: fixture.mcpUrl, authMode: 'oauth' }
		},
		db
	);
	return { id: created.id, slug: created.slug, record: created };
}

function providerFor(seeded: Seeded): OAuthProvider {
	return createOAuthProvider({
		upstreamId: seeded.id,
		slug: seeded.slug,
		serverUrl: fixture.mcpUrl,
		publicUrl: PUBLIC_URL,
		scopes: 'mcp_all'
	});
}

async function seedConnectedTokens(seeded: Seeded): Promise<void> {
	const provider = providerFor(seeded);
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

function requestCounts(): OAuthFixture['requests'] {
	return { ...fixture.requests };
}

function healthRowsFor(id: string) {
	return db
		.select()
		.from(upstreamHealth)
		.all()
		.filter((row) => row.upstreamId === id);
}

function storedUpstream(id: string) {
	return db.select().from(upstreams).where(eq(upstreams.id, id)).get();
}

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-unconfigured-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '9a'.repeat(32);
	process.env.MCPGW_PUBLIC_URL = PUBLIC_URL.origin;
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	db = getDb();
	fixture = await startOAuthFixture({ refreshMode: 'reusable' });
});

afterAll(() => {
	fixture?.stop();
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('connection test', () => {
	test('an unauthorized OAuth upstream returns unconfigured without contacting the server', async () => {
		const seeded = insertOAuthUpstream();
		const before = requestCounts();

		const result = await testUpstream(seeded.slug, { db });

		expect(result).toEqual({ ok: false, status: 'unconfigured', message: CONNECT_MESSAGE });
		expect(fixture.requests).toEqual(before);

		const stored = storedUpstream(seeded.id);
		expect((stored?.status as { state?: string } | null)?.state).toBe('unconfigured');
		expect(stored?.lastError).toBe(CONNECT_MESSAGE);

		const snapshotRecord = getSnapshot().upstreamsBySlug.get(seeded.slug);
		expect((snapshotRecord?.status as { state?: string } | null)?.state).toBe('unconfigured');

		const listRow = listLoad().rows.find((row) => row.slug === seeded.slug);
		expect(listRow?.authMode).toBe('oauth');
		expect(listRow?.status).toBe('unconfigured');
		expect(listRow?.error).toBe(CONNECT_MESSAGE);
	});

	test('a connected OAuth upstream with valid tokens still probes healthy', async () => {
		const seeded = insertOAuthUpstream();
		await seedConnectedTokens(seeded);
		expect(getOAuthConfig(seeded.id, db)?.accessTokenRef).toBeString();
		const mcpBefore = fixture.requests.mcp;

		const result = await testUpstream(seeded.slug, { db });

		expect(result.ok).toBe(true);
		expect(['healthy', 'degraded']).toContain(result.status);
		expect(result.tools ?? 0).toBeGreaterThan(0);
		expect(fixture.requests.mcp).toBeGreaterThan(mcpBefore);
	});

	test('a rejected-but-unexpired token makes the connection test unconfigured, not down', async () => {
		const seeded = insertOAuthUpstream();
		await seedConnectedTokens(seeded);
		providerFor(seeded).saveTokens({
			access_token: 'rejected-but-unexpired-token',
			token_type: 'Bearer',
			expires_in: 3_600
		});
		fixture.setRefreshMode('invalid_grant');
		const tokenBefore = fixture.requests.token;
		const mcpBefore = fixture.requests.mcp;
		const unauthorizedBefore = fixture.requests.unauthorized;
		try {
			const result = await testUpstream(seeded.slug, { db });

			expect(result.status).toBe('unconfigured');
			expect(result.ok).toBe(false);
			expect(result.message).toMatch(/authorization required/i);
			expect(fixture.requests.token).toBe(tokenBefore + 1);
			expect(fixture.requests.unauthorized).toBe(unauthorizedBefore + 1);
			expect(fixture.requests.mcp - fixture.requests.unauthorized).toBe(
				mcpBefore - unauthorizedBefore
			);

			const stored = storedUpstream(seeded.id);
			expect((stored?.status as { state?: string } | null)?.state).toBe('unconfigured');
			expect(stored?.lastError).toMatch(/authorization required/i);

			const snapshotRecord = getSnapshot().upstreamsBySlug.get(seeded.slug);
			expect((snapshotRecord?.status as { state?: string } | null)?.state).toBe('unconfigured');

			const listRow = listLoad().rows.find((row) => row.slug === seeded.slug);
			expect(listRow?.authMode).toBe('oauth');
			expect(listRow?.status).toBe('unconfigured');

			const detail = await detailLoad({ params: { slug: seeded.slug } });
			expect(detail.effectiveStatus).toBe('unconfigured');
		} finally {
			fixture.setRefreshMode('reusable');
		}
	});

	test('a static upstream with a missing env secret keeps the generic unconfigured message', async () => {
		delete process.env.MCPGW_OAUTH_UNCONFIGURED_MISSING;
		const secretName = `oauth-unconf-static-${uuidv7().slice(-8)}`;
		saveTokenSecret(secretName, 'static-value', db);
		const slug = `static-unconf-${uuidv7().slice(-8)}`;
		const created = createUpstream(
			{
				slug,
				name: slug,
				transport: 'http',
				connection: {
					url: fixture.mcpUrl,
					authMode: 'static',
					authStyle: 'bearer',
					authRef: `secret:${secretName}`
				},
				envRefs: { REQUIRED_TOKEN: '${MCPGW_OAUTH_UNCONFIGURED_MISSING}' }
			},
			db
		);
		const before = requestCounts();

		const result = await testUpstream(created.slug, { db });

		expect(result.status).toBe('unconfigured');
		expect(result.message).toContain('is not set on the gateway host');
		expect(result.message).not.toMatch(/click connect/i);
		expect(fixture.requests).toEqual(before);

		const stored = storedUpstream(created.id);
		expect(stored?.lastError).toBe(result.message);
		expect(stored?.lastError).not.toContain('[object Object]');
		const listRow = listLoad().rows.find((row) => row.slug === created.slug);
		expect(listRow?.error).toBe(result.message);
	});
});

describe('health check', () => {
	test('an unauthorized OAuth upstream becomes unconfigured, never down', async () => {
		const seeded = insertOAuthUpstream();
		const before = requestCounts();
		const pool = new UpstreamPool({ maxLive: 1 });
		try {
			const monitor = new HealthMonitor(pool, { db });
			expect(await monitor.check(seeded.record)).toBe('unconfigured');
			expect(monitor.stateOf(seeded.slug)).toBe('unconfigured');

			const rows = healthRowsFor(seeded.id);
			expect(rows).toHaveLength(1);
			expect(rows[0].status).toBe('unconfigured');
			expect(rows[0].ok).toBe(false);
			expect(rows[0].error).toMatch(/authorization required/i);
			expect(fixture.requests).toEqual(before);
		} finally {
			await pool.closeAll(0);
		}
	});

	test('a cold probe with a rejected-but-unexpired token is unconfigured on the first probe', async () => {
		const seeded = insertOAuthUpstream();
		await seedConnectedTokens(seeded);
		providerFor(seeded).saveTokens({
			access_token: 'rejected-but-unexpired-health-token',
			token_type: 'Bearer',
			expires_in: 3_600
		});
		fixture.setRefreshMode('invalid_grant');
		const tokenBefore = fixture.requests.token;
		const pool = new UpstreamPool({ maxLive: 1 });
		try {
			const monitor = new HealthMonitor(pool, { db });
			expect(await monitor.check(seeded.record)).toBe('unconfigured');

			const rows = healthRowsFor(seeded.id);
			expect(rows).toHaveLength(1);
			expect(rows[0].status).toBe('unconfigured');
			expect(rows.some((row) => row.status === 'healthy' || row.status === 'down')).toBe(false);
			expect(fixture.requests.token).toBe(tokenBefore + 1);
		} finally {
			fixture.setRefreshMode('reusable');
			await pool.closeAll(0);
		}
	});

	test('a cold connect with a near-expiry token maps a terminal refresh failure to unconfigured', async () => {
		const seeded = insertOAuthUpstream();
		await seedConnectedTokens(seeded);
		providerFor(seeded).saveTokens({
			access_token: 'stale-access-token-below-skew',
			token_type: 'Bearer',
			expires_in: 5
		});
		fixture.setRefreshMode('invalid_grant');
		const tokenBefore = fixture.requests.token;
		const pool = new UpstreamPool({ maxLive: 1 });
		try {
			const monitor = new HealthMonitor(pool, { db });
			expect(await monitor.check(seeded.record, { force: true })).toBe('unconfigured');
			expect(fixture.requests.token).toBe(tokenBefore + 1);
			expect(healthRowsFor(seeded.id).at(-1)?.status).toBe('unconfigured');
		} finally {
			fixture.setRefreshMode('reusable');
			await pool.closeAll(0);
		}
	});

	test('a warm live handle with invalid_grant refresh is unconfigured, never down', async () => {
		const seeded = insertOAuthUpstream();
		await seedConnectedTokens(seeded);
		const pool = new UpstreamPool({ maxLive: 1 });
		try {
			const warm = await pool.get(seeded.record);
			expect(warm.connected).toBe(true);
			expect(pool.peek(seeded.slug)).toBe(warm);

			providerFor(seeded).saveTokens({
				access_token: 'stale-warm-token-below-skew',
				token_type: 'Bearer',
				expires_in: 5
			});
			fixture.setRefreshMode('invalid_grant');
			const tokenBefore = fixture.requests.token;

			const monitor = new HealthMonitor(pool, { db });
			const states = [
				await monitor.check(seeded.record, { force: true }),
				await monitor.check(seeded.record, { force: true }),
				await monitor.check(seeded.record, { force: true })
			];

			expect(states).toEqual(['unconfigured', 'unconfigured', 'unconfigured']);
			expect(states).not.toContain('down');
			expect(monitor.stateOf(seeded.slug)).toBe('unconfigured');
			expect(fixture.requests.token).toBe(tokenBefore + 1);

			const rows = healthRowsFor(seeded.id);
			expect(rows.at(-1)?.status).toBe('unconfigured');
			expect(rows.every((row) => row.status !== 'down')).toBe(true);
		} finally {
			fixture.setRefreshMode('reusable');
			await pool.closeAll(0);
		}
	});

	test('a probe that throws an authorization-required error is recorded as unconfigured', async () => {
		const seeded = insertOAuthUpstream();
		const errors = [
			new UnconfiguredUpstreamError(seeded.slug, 'OAuth authorization required'),
			new OAuthAuthorizationRequiredError('https://auth.example.test/authorize', seeded.id)
		];
		for (const error of errors) {
			const pool = new UpstreamPool({
				connect: async () => {
					throw new Error('not used');
				}
			});
			try {
				const monitor = new HealthMonitor(pool, {
					db,
					probe: async () => {
						throw error;
					}
				});
				expect(await monitor.check(seeded.record)).toBe('unconfigured');
				expect(healthRowsFor(seeded.id).at(-1)?.status).toBe('unconfigured');
			} finally {
				await pool.closeAll(0);
			}
		}
	});
});

describe('dashboard projection', () => {
	test('a health-only unconfigured row is the detail page effective status', async () => {
		const seeded = insertOAuthUpstream();
		db.insert(upstreamHealth)
			.values({
				id: uuidv7(),
				upstreamId: seeded.id,
				status: 'unconfigured',
				ok: false,
				error: CONNECT_MESSAGE,
				checkedAt: new Date().toISOString()
			})
			.run();

		const detail = await detailLoad({ params: { slug: seeded.slug } });

		expect(detail.authMode).toBe('oauth');
		expect(detail.effectiveStatus).toBe('unconfigured');
		expect(detail.effectiveError).toBe(CONNECT_MESSAGE);
	});

	test('same-millisecond health rows resolve to the same latest row in list and detail', async () => {
		const seeded = insertOAuthUpstream();
		const checkedAt = new Date().toISOString();
		db.insert(upstreamHealth)
			.values({
				id: '00000000-0000-7000-8000-000000000001',
				upstreamId: seeded.id,
				status: 'healthy',
				ok: true,
				checkedAt
			})
			.run();
		db.insert(upstreamHealth)
			.values({
				id: '00000000-0000-7000-8000-000000000002',
				upstreamId: seeded.id,
				status: 'down',
				ok: false,
				error: 'latest-row',
				checkedAt
			})
			.run();

		const listRow = listLoad().rows.find((row) => row.slug === seeded.slug);
		const detail = await detailLoad({ params: { slug: seeded.slug } });

		expect(listRow?.status).toBe('down');
		expect(detail.effectiveStatus).toBe('down');
		expect(detail.history[0]?.status).toBe('down');
	});
});
