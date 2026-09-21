import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { count, eq, sql } from 'drizzle-orm';
import { resetConfigCache } from '../../src/lib/server/config';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { seedAdmin } from '../../src/lib/server/db/seed';
import { getSqlite, useDatabaseForTests, getDb, type Db } from '../../src/lib/server/db';
import {
	apiKeys,
	mcpSessions,
	profiles,
	profileUpstreams,
	toolCalls,
	upstreams,
	upstreamHealth,
	usageHourly,
	users
} from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';

let dir: string;
let db: Db;

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-db-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_ADMIN_EMAIL = 'Root@Example.com';
	process.env.MCPGW_ADMIN_PASSWORD = 'bootstrap-dev-password';
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	db = getDb();
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function tableNames(): string[] {
	const rows = getSqlite()
		.prepare("select name from sqlite_master where type = 'table'")
		.all() as Array<{ name: string }>;
	return rows.map((row) => row.name);
}

describe('migrations', () => {
	test('creates every table from the schema', () => {
		const created = tableNames();
		for (const expected of [
			'users',
			'web_sessions',
			'upstreams',
			'secret_refs',
			'upstream_health',
			'profiles',
			'profile_upstreams',
			'api_keys',
			'mcp_sessions',
			'tool_calls',
			'usage_hourly',
			'audit_log',
			'templates_applied',
			'kv'
		]) {
			expect(created, `missing table ${expected}`).toContain(expected);
		}
	});

	test('re-running migrations is a no-op', () => {
		const first = runMigrations({ dataDir: dir });
		const second = runMigrations({ dataDir: dir });
		expect(second.version).toBe(first.version);
	});
});

describe('admin bootstrap', () => {
	test('creates the configured admin with an argon2id hash', async () => {
		const result = await seedAdmin(db);
		expect(result.created).toBe(true);
		const [user] = db.select().from(users).all();
		expect(user.email).toBe('root@example.com'); // normalised to lower case
		expect(user.role).toBe('admin');
		expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$/m);
		expect(user.passwordHash).not.toContain('bootstrap-dev-password');
	});

	test('is idempotent and never resets an existing password', async () => {
		const before = db.select().from(users).all();
		process.env.MCPGW_ADMIN_PASSWORD = 'a-different-password';
		resetConfigCache();
		const result = await seedAdmin(db);
		expect(result).toMatchObject({ created: false, reason: 'account already exists' });
		const after = db.select().from(users).all();
		expect(after).toHaveLength(before.length);
		expect(after[0].passwordHash).toBe(before[0].passwordHash);
	});

	test('skips silently when the bootstrap env vars are absent', async () => {
		delete process.env.MCPGW_ADMIN_EMAIL;
		resetConfigCache();
		const result = await seedAdmin(db);
		expect(result.created).toBe(false);
		expect(result.reason).toContain('not set');
	});
});

describe('referential integrity', () => {
	const seedGraph = () => {
		const profileId = uuidv7();
		const upstreamId = uuidv7();
		const keyId = uuidv7();
		db.insert(profiles)
			.values({ id: profileId, name: `p-${profileId}` })
			.run();
		db.insert(upstreams)
			.values({
				id: upstreamId,
				slug: `u-${upstreamId.slice(-8)}`,
				name: 'demo',
				transport: 'stdio',
				connection: { command: 'true' }
			})
			.run();
		db.insert(profileUpstreams)
			.values({ profileId, upstreamId, allowGlobs: ['*'], denyGlobs: [] })
			.run();
		db.insert(apiKeys)
			.values({
				id: keyId,
				keyHash: uuidv7(),
				keyPrefix: 'mcpgw_a',
				keyTail4: '1234',
				name: 'k',
				profileId
			})
			.run();
		db.insert(mcpSessions).values({ id: uuidv7(), apiKeyId: keyId, profileId }).run();
		db.insert(upstreamHealth)
			.values({ id: uuidv7(), upstreamId, status: 'healthy', ok: true })
			.run();
		return { profileId, upstreamId, keyId };
	};

	test('a profile still used by an API key cannot be deleted (FK backstop for BR-08)', () => {
		const { profileId, keyId } = seedGraph();
		expect(() => db.delete(profiles).where(eq(profiles.id, profileId)).run()).toThrow();
		// once the key is gone, the profile is deletable and its links cascade
		db.delete(apiKeys).where(eq(apiKeys.id, keyId)).run();
		db.delete(profiles).where(eq(profiles.id, profileId)).run();
		expect(
			db.select().from(profileUpstreams).where(eq(profileUpstreams.profileId, profileId)).all()
		).toHaveLength(0);
	});

	test('deleting an API key cascades its MCP sessions', () => {
		const { profileId, keyId } = seedGraph();
		expect(db.select().from(mcpSessions).where(eq(mcpSessions.apiKeyId, keyId)).all()).toHaveLength(
			1
		);
		db.delete(apiKeys).where(eq(apiKeys.id, keyId)).run();
		expect(db.select().from(mcpSessions).where(eq(mcpSessions.apiKeyId, keyId)).all()).toHaveLength(
			0
		);
		db.delete(profiles).where(eq(profiles.id, profileId)).run();
	});

	test('deleting an upstream cascades to health and links', () => {
		const { upstreamId, profileId, keyId } = seedGraph();
		db.delete(upstreams).where(eq(upstreams.id, upstreamId)).run();
		expect(
			db.select().from(upstreamHealth).where(eq(upstreamHealth.upstreamId, upstreamId)).all()
		).toHaveLength(0);
		expect(
			db.select().from(profileUpstreams).where(eq(profileUpstreams.upstreamId, upstreamId)).all()
		).toHaveLength(0);
		db.delete(apiKeys).where(eq(apiKeys.id, keyId)).run();
		db.delete(profiles).where(eq(profiles.id, profileId)).run();
	});

	test('a tool call pointing at a nonexistent key is rejected', () => {
		expect(() =>
			db
				.insert(toolCalls)
				.values({
					id: uuidv7(),
					requestId: 'r1',
					apiKeyId: uuidv7(),
					tool: 'x',
					status: 'ok',
					durationMs: 1
				})
				.run()
		).toThrow();
	});

	test('nullable key/upstream references are allowed (retention after delete)', () => {
		const id = uuidv7();
		db.insert(toolCalls)
			.values({ id, requestId: 'r2', tool: 'orphan', status: 'ok', durationMs: 2 })
			.run();
		expect(db.select().from(toolCalls).where(eq(toolCalls.id, id)).all()).toHaveLength(1);
		db.delete(toolCalls).where(eq(toolCalls.id, id)).run();
	});
});

describe('constraints', () => {
	test('slug, email and key hash are unique', () => {
		const slug = `dup-${uuidv7().slice(0, 8)}`;
		const values = { slug, name: 'a', transport: 'stdio' as const, connection: {} };
		db.insert(upstreams)
			.values({ id: uuidv7(), ...values })
			.run();
		expect(() =>
			db
				.insert(upstreams)
				.values({ id: uuidv7(), ...values })
				.run()
		).toThrow();

		db.insert(users)
			.values({ id: uuidv7(), email: 'dup@example.com', passwordHash: 'x', role: 'viewer' })
			.run();
		expect(() =>
			db
				.insert(users)
				.values({ id: uuidv7(), email: 'dup@example.com', passwordHash: 'y', role: 'viewer' })
				.run()
		).toThrow();

		const keyValues = {
			keyHash: 'hash-1',
			keyPrefix: 'mcpgw_a',
			keyTail4: '0001',
			name: 'k',
			profileId: uuidv7()
		};
		expect(() =>
			db
				.insert(apiKeys)
				.values({ id: uuidv7(), ...keyValues })
				.run()
		).toThrow(); // FK on profile
	});

	test('a profile links an upstream at most once', () => {
		const profileId = uuidv7();
		const upstreamId = uuidv7();
		db.insert(profiles)
			.values({ id: profileId, name: `uniq-${profileId}` })
			.run();
		db.insert(upstreams)
			.values({
				id: upstreamId,
				slug: `uniq-${upstreamId.slice(-8)}`,
				name: 'u',
				transport: 'stdio',
				connection: {}
			})
			.run();
		db.insert(profileUpstreams).values({ profileId, upstreamId }).run();
		expect(() => db.insert(profileUpstreams).values({ profileId, upstreamId }).run()).toThrow();
	});

	test('usage_hourly rolls up on its composite key', () => {
		const row = {
			bucketHour: '2026-09-21T14:00:00.000Z',
			apiKeyId: 'k1',
			upstreamId: 'u1',
			tool: 'github__create_pr'
		};
		const bump = db
			.insert(usageHourly)
			.values({ ...row, calls: 1, errors: 0 })
			.onConflictDoUpdate({
				target: [
					usageHourly.bucketHour,
					usageHourly.apiKeyId,
					usageHourly.upstreamId,
					usageHourly.tool
				],
				set: { calls: sql`${usageHourly.calls} + 1` }
			});
		bump.run();
		bump.run();
		const [aggregate] = db.select().from(usageHourly).all();
		expect(aggregate.calls).toBe(2);
	});
});

describe('defaults', () => {
	test('documented column defaults are applied', () => {
		const id = uuidv7();
		db.insert(profiles)
			.values({ id, name: `defaults-${id}` })
			.run();
		const [profile] = db.select().from(profiles).where(eq(profiles.id, id)).all();
		expect(profile).toMatchObject({ rateLimitRpm: 120, dailyCallQuota: 1000, maxConcurrency: 10 });

		const upstreamId = uuidv7();
		db.insert(upstreams)
			.values({
				id: upstreamId,
				slug: `d-${id.slice(-8)}`,
				name: 'u',
				transport: 'stdio',
				connection: {}
			})
			.run();
		const [upstream] = db.select().from(upstreams).where(eq(upstreams.id, upstreamId)).all();
		expect(upstream).toMatchObject({
			enabled: true,
			pin: 'pinned',
			timeoutMs: 60_000,
			toolsCount: 0
		});
		expect(upstream.envRefs).toEqual({});

		const [{ value: users_ }] = db.select({ value: count() }).from(users).all();
		expect(users_).toBeGreaterThan(0);
	});
});
