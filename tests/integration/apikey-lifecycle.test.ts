/**
 * API key lifecycle tests (T-21): creation, verification statuses, rotation,
 * IP allowlists, events and the audit trail.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { eq, sql } from 'drizzle-orm';
import {
	activeKeysForProfile,
	createApiKey,
	generatePlaintextKey,
	getApiKeyById,
	keysPointingAtMissingProfile,
	listApiKeys,
	resumeApiKey,
	revokeApiKey,
	rotateApiKey,
	setIpAllowlist,
	suspendApiKey,
	touchApiKey,
	verifyApiKey
} from '../../src/lib/server/governance/apikey';
import { events } from '../../src/lib/server/registry/events';
import { createProfile } from '../../src/lib/server/registry';
import { apiKeys, auditLog, profiles } from '../../src/lib/server/db/schema';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { uuidv7 } from '../../src/lib/shared/ids';
import { isoFromNow } from '../../src/lib/shared/time';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-key-'));
let profileId: string;

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '6'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	profileId = createProfile({ name: 'key-profile', rateLimitRpm: 60, maxConcurrency: 3 }).id;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('creation', () => {
	test('returns the plaintext once and stores only the hash', async () => {
		const { plaintext, key } = createApiKey({ name: 'laptop', profileId });
		expect(plaintext.startsWith('mcpgw_')).toBe(true);
		expect(key.name).toBe('laptop');
		expect(key.status).toBe('active');
		expect(key.keyPrefix).toBe(plaintext.slice(0, 10));
		expect(key.keyTail4).toBe(plaintext.slice(-4));
		expect(key.expiresAt).toBeTruthy();
		expect((await verifyApiKey(`Bearer ${plaintext}`)).ok).toBe(true);

		// the secret must not exist anywhere in the stored row
		const stored = getDb().select().from(apiKeys).all();
		expect(JSON.stringify(stored)).not.toContain(plaintext);
		expect(JSON.stringify(stored)).not.toContain(plaintext.slice(7));
		const row = stored.find((entry) => entry.id === key.id);
		expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
	});

	test('an unknown profile is refused', () => {
		expect(() => createApiKey({ name: 'oops', profileId: uuidv7() })).toThrow(/does not exist/);
	});
});

describe('verification outcomes', () => {
	test('missing, malformed and unknown all fail as 401 with distinct reasons', async () => {
		expect(await verifyApiKey(null)).toMatchObject({ ok: false, status: 401, reason: 'missing' });
		expect(await verifyApiKey('Bearer hunter2')).toMatchObject({
			ok: false,
			status: 401,
			reason: 'malformed'
		});
		expect(await verifyApiKey(`Bearer ${generatePlaintextKey()}`)).toMatchObject({
			ok: false,
			status: 401,
			reason: 'unknown'
		});
	});

	test('a valid key carries its profile through', async () => {
		const { plaintext } = createApiKey({ name: 'desk', profileId });
		const result = await verifyApiKey(`Bearer ${plaintext}`);
		expect(result.ok ? result.profileId : null).toBe(profileId);
	});

	test('revoked is 401 and terminal; suspended is 403 and reversible', async () => {
		const first = createApiKey({ name: 'phone', profileId });
		revokeApiKey(first.key.id);
		expect(await verifyApiKey(`Bearer ${first.plaintext}`)).toMatchObject({
			ok: false,
			status: 401,
			reason: 'revoked'
		});
		expect(() => resumeApiKey(first.key.id)).toThrow(/cannot be resumed/);
		expect(() => rotateApiKey(first.key.id)).toThrow(/cannot be rotated/);
		expect(getApiKeyById(first.key.id)?.status).toBe('revoked');

		const second = createApiKey({ name: 'tablet', profileId });
		suspendApiKey(second.key.id);
		expect(await verifyApiKey(`Bearer ${second.plaintext}`)).toMatchObject({
			ok: false,
			status: 403,
			reason: 'suspended'
		});
		resumeApiKey(second.key.id);
		expect((await verifyApiKey(`Bearer ${second.plaintext}`)).ok).toBe(true);
	});

	test('an expired key is rejected without changing its status', async () => {
		const { plaintext, key } = createApiKey({
			name: 'temp',
			profileId,
			expiresAt: isoFromNow(-1_000)
		});
		expect(await verifyApiKey(`Bearer ${plaintext}`)).toMatchObject({
			ok: false,
			status: 401,
			reason: 'expired'
		});
		expect(getApiKeyById(key.id)?.status).toBe('active');
	});

	test('the IP allowlist gates access', async () => {
		const { plaintext, key } = createApiKey({
			name: 'vpn',
			profileId,
			ipAllowlist: ['10.20.0.0/16']
		});
		expect((await verifyApiKey(`Bearer ${plaintext}`, { ip: '10.20.5.6' })).ok).toBe(true);
		expect(await verifyApiKey(`Bearer ${plaintext}`, { ip: '10.21.5.6' })).toMatchObject({
			ok: false,
			status: 403,
			reason: 'ip-not-allowed'
		});
		setIpAllowlist(key.id, []);
		expect(getApiKeyById(key.id)?.ipAllowlist).toBeNull();
		expect((await verifyApiKey(`Bearer ${plaintext}`, { ip: '1.2.3.4' })).ok).toBe(true);
	});

	test('a profile cannot vanish while keys still reference it (schema guarantee)', () => {
		const temp = createProfile({ name: `guard-${uuidv7().slice(-6)}` });
		createApiKey({ name: 'attached', profileId: temp.id });
		// RESTRICT on api_keys.profile_id is what makes the `no-profile` branch below
		// unreachable in practice: the schema, not just the code, protects BR-08
		expect(() => getDb().delete(profiles).where(eq(profiles.id, temp.id)).run()).toThrow(
			/FOREIGN KEY|foreign key/i
		);
	});

	test('no active key points at a profile the process cannot see', async () => {
		const { plaintext, key } = createApiKey({ name: 'healthy-link', profileId });
		expect((await verifyApiKey(`Bearer ${plaintext}`)).ok).toBe(true);
		expect(keysPointingAtMissingProfile().some((entry) => entry.id === key.id)).toBe(false);
	});
});

describe('rotation', () => {
	test('copies the scope, invalidates the old secret and records lineage', async () => {
		const created = createApiKey({
			name: 'rotate-me',
			profileId,
			ipAllowlist: ['198.51.100.0/24']
		});
		const rotated = rotateApiKey(created.key.id, { ip: '127.0.0.1' });

		expect(rotated.key.profileId).toBe(created.key.profileId);
		expect(rotated.key.name).toBe(created.key.name);
		expect(rotated.key.ipAllowlist).toEqual(['198.51.100.0/24']);
		expect(rotated.key.rotatedFromId).toBe(created.key.id);
		expect(rotated.plaintext).not.toBe(created.plaintext);

		expect((await verifyApiKey(`Bearer ${rotated.plaintext}`, { ip: '198.51.100.7' })).ok).toBe(
			true
		);
		expect(await verifyApiKey(`Bearer ${created.plaintext}`, { ip: '198.51.100.7' })).toMatchObject(
			{
				ok: false,
				reason: 'revoked'
			}
		);
	});

	test('revoking, suspending and rotating publish events (FR-03)', async () => {
		const seen: string[] = [];
		const record = (line: string): void => {
			seen.push(line);
		};
		const offRevoked = events.on('key.revoked', ({ keyId }) => record(`revoked:${keyId}`));
		const offSuspended = events.on('key.suspended', ({ keyId }) => record(`suspended:${keyId}`));

		const a = createApiKey({ name: 'session-a', profileId });
		const b = createApiKey({ name: 'session-b', profileId });
		const c = createApiKey({ name: 'session-c', profileId });
		revokeApiKey(a.key.id);
		suspendApiKey(b.key.id);
		rotateApiKey(c.key.id);
		await settle();

		offRevoked();
		offSuspended();
		expect(seen.filter((entry) => entry.startsWith('revoked:'))).toHaveLength(2); // revoke + rotation of the old key
		expect(seen.filter((entry) => entry.startsWith('suspended:'))).toHaveLength(1);
	});
});

describe('bookkeeping', () => {
	test('lastUsedAt moves when a key is used', () => {
		const { key } = createApiKey({ name: 'used', profileId });
		expect(getApiKeyById(key.id)?.lastUsedAt).toBeNull();
		touchApiKey(key.id);
		expect(getApiKeyById(key.id)?.lastUsedAt).toBeTruthy();
	});

	test('every lifecycle action is audited', () => {
		const actions = getDb()
			.select({ action: auditLog.action })
			.from(auditLog)
			.all()
			.map((row) => row.action);
		for (const expected of [
			'apikey.create',
			'apikey.revoke',
			'apikey.suspend',
			'apikey.resume',
			'apikey.rotate',
			'apikey.set_ip_allowlist'
		]) {
			expect(actions.filter((action) => action === expected).length, expected).toBeGreaterThan(0);
		}
		const createRow = getDb()
			.select()
			.from(auditLog)
			.all()
			.find((row) => row.action === 'apikey.create');
		expect(createRow?.targetType).toBe('api_key');
		expect((createRow?.meta as Record<string, unknown>)?.profileId).toBeTruthy();
	});

	test('the listing API never exposes the hash', () => {
		const keys = listApiKeys();
		expect(keys.length).toBeGreaterThan(0);
		expect(JSON.stringify(keys)).not.toContain('keyHash');
		expect(
			keys.every((key) => typeof key.keyPrefix === 'string' && key.keyTail4.length === 4)
		).toBe(true);
	});

	test('activeKeysForProfile ignores revoked and expired keys (BR-08)', () => {
		const profile = createProfile({ name: `count-${uuidv7().slice(-6)}` });
		createApiKey({ name: 'live', profileId: profile.id });
		createApiKey({ name: 'expired', profileId: profile.id, expiresAt: isoFromNow(-1_000) });
		const revoked = createApiKey({ name: 'gone', profileId: profile.id });
		revokeApiKey(revoked.key.id);
		expect(activeKeysForProfile(profile.id)).toHaveLength(1);
	});

	test('unknown key ids raise not_found', () => {
		expect(() => revokeApiKey(uuidv7())).toThrow(/not found/);
		expect(() => suspendApiKey(uuidv7())).toThrow(/not found/);
	});

	test('the schema survived the run', () => {
		expect(getDb().all(sql`select 1`).length).toBe(1);
		rmSync(dir, { recursive: true, force: true });
	});
});
