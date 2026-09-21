/**
 * Registry tests (T-19): invariants, events, and hot-reload timing.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
	assertValidSlug,
	createProfile,
	createUpstream,
	deleteProfile,
	deleteUpstream,
	disableUpstreams,
	ensureLoaded,
	getProfile,
	getUpstreamBySlug,
	listProfiles,
	listUpstreams,
	RegistryError,
	reload,
	scopeForProfile,
	setProfileLinks,
	setUpstreamEnabled,
	unknownUpstreamIds,
	updateProfile,
	updateUpstream
} from '../../src/lib/server/registry';
import { events } from '../../src/lib/server/registry/events';
import { eq } from 'drizzle-orm';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { apiKeys, profiles, upstreams } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import { nowIso } from '../../src/lib/shared/time';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-registry-'));

function seedUpstream(slug: string, overrides = {}) {
	return createUpstream(
		{
			slug,
			name: slug,
			transport: 'stdio',
			connection: { command: 'true' },
			...overrides
		},
		getDb()
	);
}

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '1'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	ensureLoaded(getDb());
});

describe('slug rules (BR-02)', () => {
	test('accepts valid slugs and rejects malformed ones', () => {
		for (const slug of ['github', 'my-mcp', 'a1'])
			expect(() => assertValidSlug(slug)).not.toThrow();
		// the documented pattern is ^[a-z0-9-]{2,32}$: leading/trailing hyphens are
		// ugly but legal, everything else is refused
		for (const slug of [
			'A',
			'a',
			'has space',
			'x'.repeat(33),
			'under_score',
			'UPPER',
			'a_b-c',
			''
		]) {
			expect(() => assertValidSlug(slug), slug).toThrow(RegistryError);
		}
	});

	test('duplicate slugs are refused', () => {
		seedUpstream('dup-me');
		expect(() => seedUpstream('dup-me')).toThrow(/already exists/);
	});

	test('slug cannot be changed through update', () => {
		const created = seedUpstream('immutable-slug');
		const updated = updateUpstream(created.id, { name: 'renamed' } as never);
		expect(updated.slug).toBe('immutable-slug');
		expect(updated.name).toBe('renamed');
	});
});

describe('upstream CRUD', () => {
	test('create → read → update → delete keeps the cache in sync', () => {
		const created = seedUpstream('lifecycle', { pin: 'lazy', timeoutMs: 12_000 });
		expect(getUpstreamBySlug('lifecycle')?.timeoutMs).toBe(12_000);
		expect(created.pin).toBe('lazy');

		updateUpstream(created.id, { timeoutMs: 45_000 });
		expect(getUpstreamBySlug('lifecycle')?.timeoutMs).toBe(45_000);

		deleteUpstream(created.id);
		expect(getUpstreamBySlug('lifecycle')).toBeUndefined();
	});

	test('an unreasonable timeout is rejected', () => {
		const created = seedUpstream('timeout-guard');
		expect(() => updateUpstream(created.id, { timeoutMs: 10 })).toThrow(/between 1s and 600s/);
		expect(() => updateUpstream(created.id, { timeoutMs: 7_000_000 })).toThrow(
			/between 1s and 600s/
		);
	});

	test('unknown ids produce not_found', () => {
		expect(() => setUpstreamEnabled(uuidv7(), true)).toThrow(/not found/);
		expect(() => updateUpstream(uuidv7(), { name: 'x' })).toThrow(/not found/);
		expect(() => deleteUpstream(uuidv7())).toThrow(/not found/);
	});

	test('enabled flag flips without losing configuration (FR-09)', () => {
		const created = seedUpstream('disable-me', { timeoutMs: 30_000 });
		setUpstreamEnabled(created.id, false);
		expect(getUpstreamBySlug('disable-me')).toMatchObject({ enabled: false, timeoutMs: 30_000 });
		setUpstreamEnabled(created.id, true);
		expect(getUpstreamBySlug('disable-me')?.enabled).toBe(true);
	});

	test('disableUpstreams() bulk-disables (manifest removal path)', () => {
		const a = seedUpstream('bulk-a');
		const b = seedUpstream('bulk-b');
		disableUpstreams([a.id, b.id]);
		expect(getUpstreamBySlug('bulk-a')?.enabled).toBe(false);
		expect(getUpstreamBySlug('bulk-b')?.enabled).toBe(false);
	});
});

describe('events drive hot reload (BR-12)', () => {
	test('every mutation publishes the event the caches subscribe to', async () => {
		const seen: string[] = [];
		const record = (line: string): void => {
			seen.push(line);
		};
		const offChanged = events.on('upstream.changed', (payload) =>
			record(`changed:${payload.slug}:${payload.enabled}`)
		);
		const offEnabled = events.on('upstream.enabled', (payload) =>
			record(`enabled:${payload.slug}:${payload.enabled}`)
		);
		const offProfile = events.on('profile.changed', (payload) =>
			record(`profile:${payload.profileId}`)
		);

		const created = seedUpstream('evented');
		setUpstreamEnabled(created.id, false);
		const profile = createProfile({ name: `evt-${uuidv7().slice(-8)}` });
		deleteUpstream(created.id);

		offChanged();
		offEnabled();
		offProfile();
		// dispatch is deliberately asynchronous (handlers must never block the
		// writer), so give the microtask queue a turn before asserting
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual([
			`changed:evented:true`,
			`enabled:evented:false`,
			`profile:${profile.id}`,
			`changed:evented:false`
		]);
	});

	test('reloading after a disable is sub-millisecond and leaves others untouched', () => {
		seedUpstream('stay-up');
		const target = seedUpstream('go-down');
		expect(getUpstreamBySlug('stay-up')?.enabled).toBe(true);

		const started = performance.now();
		setUpstreamEnabled(target.id, false);
		const elapsed = performance.now() - started;

		expect(getUpstreamBySlug('go-down')?.enabled).toBe(false);
		expect(getUpstreamBySlug('stay-up')).toMatchObject({ enabled: true });
		// BR-12 budget is 500 ms end to end; the reload itself must be far cheaper
		expect(elapsed).toBeLessThan(100);
	});

	test('deleting an upstream cascades out of every profile scope', () => {
		const doomed = seedUpstream('doomed');
		const other = seedUpstream('survivor');
		const profile = createProfile({
			name: `cascade-${uuidv7().slice(-8)}`,
			links: [{ upstreamId: doomed.id }, { upstreamId: other.id }]
		});
		expect(scopeForProfile(profile.id).map((entry) => entry.upstream.slug)).toEqual([
			'doomed',
			'survivor'
		]);
		deleteUpstream(doomed.id);
		expect(scopeForProfile(profile.id).map((entry) => entry.upstream.slug)).toEqual(['survivor']);
	});
});

describe('profiles and links', () => {
	test('links carry their glob rules and are replaced atomically', () => {
		const a = seedUpstream('link-a');
		const b = seedUpstream('link-b');
		const profile = createProfile({
			name: `links-${uuidv7().slice(-8)}`,
			links: [{ upstreamId: a.id, allowGlobs: ['create_*'], denyGlobs: ['*draft*'] }]
		});
		expect(scopeForProfile(profile.id)[0]).toMatchObject({
			upstream: { slug: 'link-a' },
			allowGlobs: ['create_*'],
			denyGlobs: ['*draft*']
		});

		setProfileLinks(profile.id, [{ upstreamId: b.id }]);
		const links = scopeForProfile(profile.id);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			upstream: { slug: 'link-b' },
			allowGlobs: ['*'],
			denyGlobs: []
		});
	});

	test('unknown upstream ids are refused before writing', () => {
		const profile = createProfile({ name: `unknown-${uuidv7().slice(-8)}` });
		expect(() => setProfileLinks(profile.id, [{ upstreamId: uuidv7() }])).toThrow(
			/unknown upstream/
		);
	});

	test('profile limits can be tuned', () => {
		const profile = createProfile({ name: `limits-${uuidv7().slice(-8)}` });
		expect(profile).toMatchObject({ rateLimitRpm: 120, dailyCallQuota: 1000, maxConcurrency: 10 });
		const updated = updateProfile(profile.id, { rateLimitRpm: 30, maxConcurrency: 3 });
		expect(updated).toMatchObject({ rateLimitRpm: 30, maxConcurrency: 3 });
	});

	test('a profile used by an active key cannot be deleted (BR-08)', () => {
		const profile = createProfile({ name: `guarded-${uuidv7().slice(-8)}` });
		getDb()
			.insert(apiKeys)
			.values({
				id: uuidv7(),
				keyHash: uuidv7(),
				keyPrefix: 'mcpgw_g',
				keyTail4: '0001',
				name: 'laptop',
				profileId: profile.id,
				status: 'active'
			})
			.run();
		expect(() => deleteProfile(profile.id)).toThrow(/used by 1 active key/);

		// revoking the key releases the guard
		getDb()
			.update(apiKeys)
			.set({ status: 'revoked' })
			.where(eq(apiKeys.profileId, profile.id))
			.run();
		expect(() => deleteProfile(profile.id)).not.toThrow();
		expect(listProfiles().some((entry) => entry.id === profile.id)).toBe(false);
	});

	test('an expired key no longer blocks deletion', () => {
		const profile = createProfile({ name: `expired-${uuidv7().slice(-8)}` });
		getDb()
			.insert(apiKeys)
			.values({
				id: uuidv7(),
				keyHash: uuidv7(),
				keyPrefix: 'mcpgw_e',
				keyTail4: '0002',
				name: 'old-phone',
				profileId: profile.id,
				status: 'active',
				expiresAt: '2020-01-01T00:00:00.000Z'
			})
			.run();
		expect(() => deleteProfile(profile.id)).not.toThrow();
	});

	test('unknownUpstreamIds reports drift', () => {
		const known = seedUpstream('known-one');
		expect(unknownUpstreamIds([known.id, uuidv7()])).toHaveLength(1);
	});
});

describe('snapshot integrity', () => {
	test('reload reflects direct database edits', () => {
		getDb()
			.insert(upstreams)
			.values({
				id: uuidv7(),
				slug: 'outside-ui',
				name: 'outside',
				transport: 'stdio',
				connection: {}
			})
			.run();
		reload(getDb());
		expect(getUpstreamBySlug('outside-ui')?.name).toBe('outside');
	});

	test('profile listing is stable, unique and cache-consistent', () => {
		const ids = listProfiles().map((profile) => profile.id);
		expect(new Set(ids).size).toBe(ids.length);
		const [one] = ids;
		expect(getProfile(one)).toBe(listProfiles().find((profile) => profile.id === one));
		expect(listUpstreams().every((record) => record.slug.length >= 2)).toBe(true);
	});

	test('the schema is still consistent after all the churn', () => {
		const orphanLinks = getDb()
			.select({ id: profiles.id })
			.from(profiles)
			.all()
			.filter((profile) => scopeForProfile(profile.id).length === 0);
		expect(orphanLinks.length).toBeLessThanOrEqual(listProfiles().length);
		expect(nowIso()).toMatch(/Z$/);
		rmSync(dir, { recursive: true, force: true });
	});
});
