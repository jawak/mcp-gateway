/**
 * Registry (T-19) — the only place that writes upstream/profile config.
 *
 * Reads are cheap because everything the request path needs is cached in memory
 * and rebuilt on `reload()`. Writes go through here so that:
 *   - invariants hold in one place (slug format + immutability, BR-02; a profile
 *     still used by an active key cannot be deleted, BR-08)
 *   - every change publishes an event, so caches and connections react within
 *     milliseconds without a restart (BR-12, "hot reload ≤ 500 ms")
 *   - the dashboard, the CLI and a manifest import all follow the same path
 */
import { and, count, eq, inArray } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.ts';
import { apiKeys, profileUpstreams, profiles, upstreams } from '../db/schema.ts';
import { toUpstreamRecord } from '../upstream/health.ts';
import { uuidv7 } from '../../shared/ids.ts';
import { isPast, nowIso } from '../../shared/time.ts';
import { events } from './events.ts';
import { logger } from '../observability/logger.ts';
import { recordAudit } from '../observability/audit.ts';
import { status } from '../observability/status.ts';
import type { UpstreamRecord } from '../upstream/types.ts';

const log = logger.child({ component: 'registry' });

export const SLUG_PATTERN = /^[a-z0-9-]{2,32}$/;

/**
 * Every write takes these. `db` may still be passed positionally by tests and
 * scripts; `actorId`/`ip`/`requestId` exist so each configuration change leaves an
 * audit trail (T-25) rather than only a timestamp.
 */
export type WriteOptions = {
	db?: Db;
	actorId?: string | null;
	ip?: string | null;
	requestId?: string | null;
};

function writeOptions(
	input: Db | WriteOptions = {}
): Required<Omit<WriteOptions, 'actorId' | 'ip' | 'requestId'>> & WriteOptions {
	// a Drizzle instance is object-like but has no `db` property
	const isOptions =
		typeof (input as WriteOptions).db !== 'undefined' || !('select' in (input as object));
	const options = (isOptions ? input : { db: input as Db }) as WriteOptions;
	return { ...options, db: options.db ?? getDb() };
}

export class RegistryError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'RegistryError';
		this.code = code;
	}
}

export type UpstreamPatch = Partial<{
	name: string;
	transport: 'stdio' | 'http';
	connection: UpstreamRecord['connection'];
	envRefs: Record<string, string>;
	headersRef: string | null;
	timeoutMs: number;
	pin: 'pinned' | 'lazy';
}>;

export type ProfileLink = { upstreamId: string; allowGlobs?: string[]; denyGlobs?: string[] };

export type ScopeEntry = {
	upstream: UpstreamRecord;
	allowGlobs: string[];
	denyGlobs: string[];
};

export type CachedProfile = {
	id: string;
	name: string;
	rateLimitRpm: number;
	dailyCallQuota: number;
	maxConcurrency: number;
	defaultTimeoutMs: number;
	links: ScopeEntry[];
};

export type RegistrySnapshot = {
	upstreamsById: Map<string, UpstreamRecord>;
	upstreamsBySlug: Map<string, UpstreamRecord>;
	profilesById: Map<string, CachedProfile>;
	generatedAt: string;
};

let snapshot: RegistrySnapshot = emptySnapshot();

function emptySnapshot(): RegistrySnapshot {
	return {
		upstreamsById: new Map(),
		upstreamsBySlug: new Map(),
		profilesById: new Map(),
		generatedAt: nowIso()
	};
}

/** Re-read config into memory. Cheap enough to call after every write. */
export function reload(db: Db = getDb()): RegistrySnapshot {
	const upstreamRows = db.select().from(upstreams).all();
	const profileRows = db.select().from(profiles).all();
	const linkRows = db.select().from(profileUpstreams).all();

	const upstreamsById = new Map<string, UpstreamRecord>();
	const upstreamsBySlug = new Map<string, UpstreamRecord>();
	for (const row of upstreamRows) {
		const record = toUpstreamRecord(row);
		upstreamsById.set(record.id, record);
		upstreamsBySlug.set(record.slug, record);
	}

	const profilesById = new Map<string, CachedProfile>();
	for (const profile of profileRows) {
		const links = linkRows
			.filter((link) => link.profileId === profile.id)
			.map((link) => {
				const upstream = upstreamsById.get(link.upstreamId);
				if (!upstream) return undefined;
				return {
					upstream,
					allowGlobs: link.allowGlobs ?? ['*'],
					denyGlobs: link.denyGlobs ?? []
				};
			})
			.filter((entry): entry is ScopeEntry => entry !== undefined);
		profilesById.set(profile.id, {
			id: profile.id,
			name: profile.name,
			rateLimitRpm: profile.rateLimitRpm,
			dailyCallQuota: profile.dailyCallQuota,
			maxConcurrency: profile.maxConcurrency,
			defaultTimeoutMs: profile.defaultTimeoutMs,
			links
		});
	}

	snapshot = { upstreamsById, upstreamsBySlug, profilesById, generatedAt: nowIso() };
	status.liveUpstreams = [...upstreamsById.values()].filter((record) => record.enabled).length;
	return snapshot;
}

export function getSnapshot(): RegistrySnapshot {
	return snapshot;
}

/** Load once at boot; tolerant of a database that has not been migrated yet. */
export function ensureLoaded(db: Db = getDb()): RegistrySnapshot {
	try {
		return reload(db);
	} catch (error) {
		log.warn({ err: error }, 'registry not loaded yet');
		return snapshot;
	}
}

export function listUpstreams(db: Db = getDb()): UpstreamRecord[] {
	reload(db);
	return [...getSnapshot().upstreamsById.values()];
}

export function getUpstreamBySlug(slug: string): UpstreamRecord | undefined {
	return snapshot.upstreamsBySlug.get(slug);
}

export function getUpstreamById(id: string): UpstreamRecord | undefined {
	return snapshot.upstreamsById.get(id);
}

export function getProfile(id: string): CachedProfile | undefined {
	return snapshot.profilesById.get(id);
}

export function listProfiles(): CachedProfile[] {
	return [...snapshot.profilesById.values()];
}

/** Upstreams a profile may expose, in configuration order. */
export function scopeForProfile(profileId: string): ScopeEntry[] {
	return getProfile(profileId)?.links ?? [];
}

function audit(
	action: string,
	targetId: string,
	actorId: string | null | undefined,
	ip: string | null | undefined,
	requestId: string | null | undefined,
	meta: Record<string, unknown>,
	db: Db
): void {
	recordAudit({
		actorType: 'user',
		actorId: actorId ?? null,
		action,
		targetType: 'config',
		targetId,
		ip: ip ?? null,
		requestId: requestId ?? null,
		meta,
		db
	});
}

/** Names are friendlier than ids in an audit timeline; the id is still recorded. */
function profileNameOf(profileId: string): string {
	return snapshot.profilesById.get(profileId)?.name ?? profileId;
}

export function assertValidSlug(slug: string): void {
	if (!SLUG_PATTERN.test(slug)) {
		throw new RegistryError(
			'invalid_slug',
			'slug must be 2-32 characters, lowercase letters, digits or hyphens (used as the tool namespace prefix)'
		);
	}
}

export type CreateUpstreamInput = Omit<UpstreamPatch, 'id'> & {
	slug: string;
	name: string;
	transport: 'stdio' | 'http';
	connection: UpstreamRecord['connection'];
	id?: string;
	enabled?: boolean;
};

export function createUpstream(
	input: CreateUpstreamInput,
	writer: Db | WriteOptions = {}
): UpstreamRecord {
	const { db, actorId, ip, requestId } = writeOptions(writer);
	assertValidSlug(input.slug);
	if (snapshot.upstreamsBySlug.has(input.slug)) {
		throw new RegistryError('duplicate_slug', `an upstream named "${input.slug}" already exists`);
	}
	const id = input.id ?? uuidv7();
	const createdAt = nowIso();
	db.insert(upstreams)
		.values({
			id,
			slug: input.slug,
			name: input.name,
			transport: input.transport,
			enabled: input.enabled ?? true,
			connection: input.connection as Record<string, unknown>,
			envRefs: input.envRefs ?? {},
			headersRef: input.headersRef ?? null,
			timeoutMs: input.timeoutMs ?? 60_000,
			pin: input.pin ?? 'pinned',
			createdAt,
			updatedAt: createdAt
		})
		.run();
	reload(db);
	events.emit('upstream.changed', { slug: input.slug, enabled: input.enabled ?? true });
	// the definition may reference secrets, so only the shape goes into the audit row
	audit(
		'upstream.create',
		input.slug,
		actorId,
		ip,
		requestId,
		{ transport: input.transport, pin: input.pin ?? 'pinned' },
		db
	);
	log.info({ slug: input.slug, transport: input.transport }, 'upstream created');
	return getUpstreamById(id) as UpstreamRecord;
}

/**
 * Update an upstream. `slug` is deliberately not updatable: it is the namespace
 * prefix every client already sees (BR-02).
 */
export function updateUpstream(
	id: string,
	patch: UpstreamPatch,
	writer: Db | WriteOptions = {}
): UpstreamRecord {
	const { db, actorId, ip, requestId } = writeOptions(writer);
	const existing = snapshot.upstreamsById.get(id);
	if (!existing) throw new RegistryError('not_found', 'upstream not found');
	if (patch.timeoutMs !== undefined && (patch.timeoutMs < 1_000 || patch.timeoutMs > 600_000)) {
		throw new RegistryError('invalid_timeout', 'timeout must be between 1s and 600s');
	}
	db.update(upstreams)
		.set({
			...(patch.name !== undefined ? { name: patch.name } : {}),
			...(patch.transport !== undefined ? { transport: patch.transport } : {}),
			...(patch.connection !== undefined
				? { connection: patch.connection as Record<string, unknown> }
				: {}),
			...(patch.envRefs !== undefined ? { envRefs: patch.envRefs } : {}),
			...(patch.headersRef !== undefined ? { headersRef: patch.headersRef } : {}),
			...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
			...(patch.pin !== undefined ? { pin: patch.pin } : {}),
			updatedAt: nowIso()
		} as never)
		.where(eq(upstreams.id, id))
		.run();
	reload(db);
	const updated = getUpstreamById(id) as UpstreamRecord;
	events.emit('upstream.changed', { slug: updated.slug, enabled: updated.enabled });
	audit(
		'upstream.update',
		updated.slug,
		actorId,
		ip,
		requestId,
		{ fields: Object.keys(patch) },
		db
	);
	log.info({ slug: updated.slug }, 'upstream updated');
	return updated;
}

/** Enable/disable without dropping configuration (FR-09). */
export function setUpstreamEnabled(
	id: string,
	enabled: boolean,
	writer: Db | WriteOptions = {}
): UpstreamRecord {
	const { db, actorId, ip, requestId } = writeOptions(writer);
	const existing = snapshot.upstreamsById.get(id);
	if (!existing) throw new RegistryError('not_found', 'upstream not found');
	db.update(upstreams).set({ enabled, updatedAt: nowIso() }).where(eq(upstreams.id, id)).run();
	reload(db);
	events.emit('upstream.enabled', { slug: existing.slug, enabled });
	audit(
		enabled ? 'upstream.enable' : 'upstream.disable',
		existing.slug,
		actorId,
		ip,
		requestId,
		{},
		db
	);
	log.info({ slug: existing.slug, enabled }, 'upstream enabled flag changed');
	return getUpstreamById(id) as UpstreamRecord;
}

/**
 * Hard delete. The profile links cascade (schema), and we reload so caches drop
 * it; the pool closes the connection via the `upstream.changed` subscriber.
 */
export function deleteUpstream(id: string, writer: Db | WriteOptions = {}): void {
	const { db, actorId, ip, requestId } = writeOptions(writer);
	const existing = snapshot.upstreamsById.get(id);
	if (!existing) throw new RegistryError('not_found', 'upstream not found');
	db.delete(upstreams).where(eq(upstreams.id, id)).run();
	reload(db);
	events.emit('upstream.changed', { slug: existing.slug, enabled: false });
	audit('upstream.delete', existing.slug, actorId, ip, requestId, {}, db);
	log.info({ slug: existing.slug }, 'upstream deleted');
}

export type CreateProfileInput = {
	name: string;
	rateLimitRpm?: number;
	dailyCallQuota?: number;
	maxConcurrency?: number;
	defaultTimeoutMs?: number;
	links?: ProfileLink[];
};

export function createProfile(
	input: CreateProfileInput,
	writer: Db | WriteOptions = {}
): CachedProfile {
	const { db, actorId, ip, requestId } = writeOptions(writer);
	const id = uuidv7();
	const createdAt = nowIso();
	db.transaction((tx) => {
		tx.insert(profiles)
			.values({
				id,
				name: input.name,
				rateLimitRpm: input.rateLimitRpm ?? 120,
				dailyCallQuota: input.dailyCallQuota ?? 1000,
				maxConcurrency: input.maxConcurrency ?? 10,
				defaultTimeoutMs: input.defaultTimeoutMs ?? 60_000,
				createdAt,
				updatedAt: createdAt
			})
			.run();
		for (const link of input.links ?? []) {
			tx.insert(profileUpstreams)
				.values({
					profileId: id,
					upstreamId: link.upstreamId,
					allowGlobs: link.allowGlobs ?? ['*'],
					denyGlobs: link.denyGlobs ?? []
				})
				.run();
		}
	});
	reload(db);
	events.emit('profile.changed', { profileId: id });
	audit(
		'profile.create',
		input.name,
		actorId,
		ip,
		requestId,
		{ links: input.links?.length ?? 0 },
		db
	);
	return getProfile(id) as CachedProfile;
}

/** Replace the upstream set of a profile in one transaction. */
export function setProfileLinks(
	profileId: string,
	links: ProfileLink[],
	writer: Db | WriteOptions = {}
): CachedProfile {
	const { db, actorId, ip, requestId } = writeOptions(writer);
	if (!snapshot.profilesById.has(profileId))
		throw new RegistryError('not_found', 'profile not found');
	const unknown = links.filter((link) => !snapshot.upstreamsById.has(link.upstreamId));
	if (unknown.length > 0) {
		throw new RegistryError(
			'unknown_upstream',
			`unknown upstream id(s): ${unknown.map((link) => link.upstreamId).join(', ')}`
		);
	}
	db.transaction((tx) => {
		tx.delete(profileUpstreams).where(eq(profileUpstreams.profileId, profileId)).run();
		for (const link of links) {
			tx.insert(profileUpstreams)
				.values({
					profileId,
					upstreamId: link.upstreamId,
					allowGlobs: link.allowGlobs ?? ['*'],
					denyGlobs: link.denyGlobs ?? []
				})
				.run();
		}
		tx.update(profiles).set({ updatedAt: nowIso() }).where(eq(profiles.id, profileId)).run();
	});
	reload(db);
	events.emit('profile.changed', { profileId });
	audit(
		'profile.set_links',
		profileNameOf(profileId),
		actorId,
		ip,
		requestId,
		{ links: links.length },
		db
	);
	return getProfile(profileId) as CachedProfile;
}

/** Keys that still reference a profile (used by the delete guard and the UI). */
export function activeKeysForProfile(profileId: string, db: Db = getDb()) {
	return db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			keyPrefix: apiKeys.keyPrefix,
			keyTail4: apiKeys.keyTail4
		})
		.from(apiKeys)
		.where(and(eq(apiKeys.profileId, profileId), eq(apiKeys.status, 'active')))
		.all()
		.filter((key) => !isPast(keyExpiresAt(db, key.id)));
}

function keyExpiresAt(db: Db, keyId: string): string | null {
	const [row] = db
		.select({ expiresAt: apiKeys.expiresAt })
		.from(apiKeys)
		.where(eq(apiKeys.id, keyId))
		.all();
	return row?.expiresAt ?? null;
}

/** BR-08: a profile in use by an active key cannot be deleted. */
export function deleteProfile(profileId: string, writer: Db | WriteOptions = {}): void {
	const { db, actorId, ip, requestId } = writeOptions(writer);
	if (!snapshot.profilesById.has(profileId))
		throw new RegistryError('not_found', 'profile not found');
	const profileName = profileNameOf(profileId);
	const blockers = activeKeysForProfile(profileId, db);
	const history =
		db.select({ value: count() }).from(apiKeys).where(eq(apiKeys.profileId, profileId)).all()[0]
			?.value ?? 0;
	if (blockers.length > 0) {
		throw new RegistryError(
			'profile_in_use',
			`profile is used by ${blockers.length} active key(s): ${blockers.map((key) => key.name).join(', ')} — reassign them first`
		);
	}
	// Only active keys block deletion (BR-08). The profile_id column is NOT NULL
	// with a RESTRICT foreign key, so the remaining history rows (revoked or
	// expired keys) are removed with the profile; their `tool_calls` survive
	// because that reference is ON DELETE SET NULL, and the audit trail keeps the
	// actor as text.
	db.transaction((tx) => {
		tx.delete(apiKeys).where(eq(apiKeys.profileId, profileId)).run();
		tx.delete(profiles).where(eq(profiles.id, profileId)).run();
	});
	reload(db);
	events.emit('profile.changed', { profileId });
	audit('profile.delete', profileName, actorId, ip, requestId, { discardedKeys: history }, db);
	log.info({ profileId, discardedKeys: history }, 'profile deleted');
}

export function updateProfile(
	profileId: string,
	patch: Partial<
		Pick<
			CachedProfile,
			'name' | 'rateLimitRpm' | 'dailyCallQuota' | 'maxConcurrency' | 'defaultTimeoutMs'
		>
	>,
	writer: Db | WriteOptions = {}
): CachedProfile {
	const { db, actorId, ip, requestId } = writeOptions(writer);
	if (!snapshot.profilesById.has(profileId))
		throw new RegistryError('not_found', 'profile not found');
	db.update(profiles)
		.set({ ...(patch as object), updatedAt: nowIso() } as never)
		.where(eq(profiles.id, profileId))
		.run();
	reload(db);
	events.emit('profile.changed', { profileId });
	audit(
		'profile.update',
		profileNameOf(profileId),
		actorId,
		ip,
		requestId,
		{ fields: Object.keys(patch) },
		db
	);
	return getProfile(profileId) as CachedProfile;
}

/** Delete a set of upstreams at once (manifest import "removed" entries disable instead). */
export function disableUpstreams(ids: string[], db: Db = getDb()): void {
	if (ids.length === 0) return;
	db.update(upstreams)
		.set({ enabled: false, updatedAt: nowIso() })
		.where(inArray(upstreams.id, ids))
		.run();
	reload(db);
	for (const id of ids) {
		const record = getUpstreamById(id);
		if (record) events.emit('upstream.enabled', { slug: record.slug, enabled: false });
	}
}

/** Upstream ids a profile references that no longer exist (config drift check). */
export function unknownUpstreamIds(ids: string[]): string[] {
	return ids.filter((id) => !snapshot.upstreamsById.has(id));
}
