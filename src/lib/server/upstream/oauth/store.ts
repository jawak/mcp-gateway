/**
 * Vault-backed OAuth persistence (datadog-mcp-oauth).
 *
 * Two invariants drive this module:
 *   1. `upstream_oauth` stores references only. Every token, refresh token and
 *      optional DCR client secret lives in `secret_refs` sealed with the vault,
 *      under a deterministic `oauth_<slug>_<kind>` name.
 *   2. Writes made on behalf of the gateway (never a user form) are audited as
 *      `actorType: 'system'` with the secret NAME only — never the value.
 *
 * This is an internal module: no route or transport imports it for reads.
 */
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { eq } from 'drizzle-orm';
import { getDb, type Db } from '../../db/index.ts';
import { secretRefs, upstreamOauth, upstreamOauthPending, upstreams } from '../../db/schema.ts';
import { recordAudit } from '../../observability/audit.ts';
import { openSecret, sealSecret, VaultError } from '../../security/vault.ts';
import { isoFromNow, nowIso } from '../../../shared/time.ts';
import { uuidv7 } from '../../../shared/ids.ts';

export type OAuthConfig = typeof upstreamOauth.$inferSelect;
export type OAuthRecord = typeof upstreamOauth.$inferInsert;
export type OAuthStatus = OAuthConfig['status'];
export type OAuthConfigPatch = Partial<Omit<OAuthRecord, 'upstreamId' | 'createdAt' | 'updatedAt'>>;

export type PendingRow = typeof upstreamOauthPending.$inferSelect;

export type CreatePendingInput = {
	state: string;
	upstreamId: string;
	redirectUri: string;
	createdBy?: string | null;
	ttlMs: number;
	/** Pre-sealed PKCE verifier; defaults to a sealed empty string until todo 5 writes it. */
	verifierSealed?: string;
};

export type SaveTokenSecretResult = { name: string; rotated: boolean };

/** Same shape as `governance/secrets.ts`; duplicated to avoid a registry import cycle. */
const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_SLUG_IN_NAME = 32;

export type OAuthTokenKind = 'access' | 'refresh' | 'client_secret';

/** Deterministic, slug-safe secret name, e.g. `oauth_datadog_access`. */
export function oauthTokenName(slug: string, kind: OAuthTokenKind): string {
	const safe = slug
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, '_')
		.slice(0, MAX_SLUG_IN_NAME);
	return `oauth_${safe}_${kind}`;
}

function slugFor(upstreamId: string, db: Db): string {
	const row = db
		.select({ slug: upstreams.slug })
		.from(upstreams)
		.where(eq(upstreams.id, upstreamId))
		.get();
	if (!row) throw new Error(`unknown upstream: ${upstreamId}`);
	return row.slug;
}

function requireSecretName(name: string): void {
	if (!SECRET_NAME_PATTERN.test(name)) {
		throw new Error(`invalid oauth secret name: ${name}`);
	}
}

function writeSecret(name: string, value: string, db: Db): SaveTokenSecretResult {
	requireSecretName(name);
	if (value.length === 0) throw new Error(`refusing to store an empty oauth secret: ${name}`);

	const sealed = sealSecret(value);
	const existing = db
		.select({ id: secretRefs.id })
		.from(secretRefs)
		.where(eq(secretRefs.name, name))
		.get();
	const timestamp = nowIso();

	if (existing) {
		db.update(secretRefs)
			.set({
				cipher: sealed.cipher,
				iv: sealed.iv,
				tag: sealed.tag,
				keyVer: sealed.keyVer,
				rotatedAt: timestamp
			})
			.where(eq(secretRefs.name, name))
			.run();
	} else {
		db.insert(secretRefs)
			.values({
				id: uuidv7(),
				name,
				cipher: sealed.cipher,
				iv: sealed.iv,
				tag: sealed.tag,
				keyVer: sealed.keyVer,
				createdAt: timestamp
			})
			.run();
	}

	recordAudit({
		actorType: 'system',
		action: existing ? 'oauth.token.rotate' : 'oauth.token.store',
		targetType: 'secret',
		targetId: name,
		// the NAME is safe; the value must never reach an audit row
		meta: { name },
		db
	});

	return { name, rotated: Boolean(existing) };
}

// ---------------------------------------------------------------------------
// OAuth configuration row
// ---------------------------------------------------------------------------

export function getOAuthConfig(upstreamId: string, db: Db = getDb()): OAuthConfig | undefined {
	return db.select().from(upstreamOauth).where(eq(upstreamOauth.upstreamId, upstreamId)).get();
}

export function upsertOAuthConfig(
	upstreamId: string,
	patch: OAuthConfigPatch,
	db: Db = getDb()
): OAuthConfig {
	const timestamp = nowIso();
	db.insert(upstreamOauth)
		.values({
			upstreamId,
			...patch,
			createdAt: timestamp,
			updatedAt: timestamp
		})
		.onConflictDoUpdate({
			target: upstreamOauth.upstreamId,
			set: { ...patch, updatedAt: timestamp }
		})
		.run();

	const row = getOAuthConfig(upstreamId, db);
	if (!row) throw new Error(`oauth config for ${upstreamId} was not persisted`);
	return row;
}

export function deleteOAuthConfig(upstreamId: string, db: Db = getDb()): void {
	db.delete(upstreamOauth).where(eq(upstreamOauth.upstreamId, upstreamId)).run();
}

export function setOAuthStatus(
	upstreamId: string,
	status: OAuthStatus,
	options: { lastError?: string | null; connectedBy?: string | null } = {},
	db: Db = getDb()
): OAuthConfig {
	const patch: OAuthConfigPatch = {
		status,
		lastError: options.lastError ?? null
	};
	if (options.connectedBy !== undefined) patch.connectedBy = options.connectedBy;
	if (status === 'connected') patch.connectedAt = nowIso();
	return upsertOAuthConfig(upstreamId, patch, db);
}

// ---------------------------------------------------------------------------
// Sealed secret access
// ---------------------------------------------------------------------------

export function saveTokenSecret(
	name: string,
	value: string,
	db: Db = getDb()
): SaveTokenSecretResult {
	return writeSecret(name, value, db);
}

export function readTokenSecret(name: string, db: Db = getDb()): string | undefined {
	if (!SECRET_NAME_PATTERN.test(name)) return undefined;
	const row = db.select().from(secretRefs).where(eq(secretRefs.name, name)).get();
	if (!row) return undefined;
	try {
		return openSecret({ cipher: row.cipher, iv: row.iv, tag: row.tag, keyVer: row.keyVer });
	} catch (error) {
		if (error instanceof VaultError) return undefined;
		throw error;
	}
}

export function deleteTokenSecret(name: string, db: Db = getDb()): boolean {
	if (!SECRET_NAME_PATTERN.test(name)) return false;
	const removed = db
		.delete(secretRefs)
		.where(eq(secretRefs.name, name))
		.returning({ name: secretRefs.name })
		.all();
	if (removed.length === 0) return false;
	recordAudit({
		actorType: 'system',
		action: 'oauth.token.clear',
		targetType: 'secret',
		targetId: name,
		meta: { name },
		db
	});
	return true;
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/**
 * Seal the token response and point `upstream_oauth` at it.
 *
 * A refresh response may omit `refresh_token` (the server keeps the old one);
 * in that case the existing refresh reference is preserved untouched. An
 * omitted `expires_in` stores a NULL deadline so freshness is driven by a 401,
 * never by a fabricated timestamp.
 */
export function saveTokens(upstreamId: string, tokens: OAuthTokens, db: Db = getDb()): OAuthConfig {
	const slug = slugFor(upstreamId, db);
	const existing = getOAuthConfig(upstreamId, db);

	const accessRef = oauthTokenName(slug, 'access');
	writeSecret(accessRef, tokens.access_token, db);

	let refreshRef = existing?.refreshTokenRef ?? null;
	if (tokens.refresh_token) {
		refreshRef = oauthTokenName(slug, 'refresh');
		writeSecret(refreshRef, tokens.refresh_token, db);
	}

	const expiresIn = tokens.expires_in;
	const expiresAt =
		typeof expiresIn === 'number' && Number.isFinite(expiresIn)
			? isoFromNow(Math.max(0, Math.round(expiresIn * 1000)))
			: null;

	return upsertOAuthConfig(
		upstreamId,
		{
			status: 'connected',
			accessTokenRef: accessRef,
			refreshTokenRef: refreshRef,
			expiresAt,
			tokenType: tokens.token_type ?? existing?.tokenType ?? null,
			grantedScope: tokens.scope ?? existing?.grantedScope ?? null,
			lastError: null,
			connectedAt: nowIso()
		},
		db
	);
}

/** Drop both sealed tokens and every reference/metadata derived from them. */
export function clearTokens(upstreamId: string, db: Db = getDb()): void {
	const slug = slugFor(upstreamId, db);
	deleteTokenSecret(oauthTokenName(slug, 'access'), db);
	deleteTokenSecret(oauthTokenName(slug, 'refresh'), db);

	const existing = getOAuthConfig(upstreamId, db);
	if (!existing) return;
	db.update(upstreamOauth)
		.set({
			accessTokenRef: null,
			refreshTokenRef: null,
			expiresAt: null,
			grantedScope: null,
			updatedAt: nowIso()
		})
		.where(eq(upstreamOauth.upstreamId, upstreamId))
		.run();
}

export function saveClientSecret(
	upstreamId: string,
	value: string,
	db: Db = getDb()
): SaveTokenSecretResult {
	const slug = slugFor(upstreamId, db);
	const name = oauthTokenName(slug, 'client_secret');
	const result = writeSecret(name, value, db);
	upsertOAuthConfig(upstreamId, { clientSecretRef: name }, db);
	return result;
}

export function readClientSecret(upstreamId: string, db: Db = getDb()): string | undefined {
	const ref = getOAuthConfig(upstreamId, db)?.clientSecretRef;
	return ref ? readTokenSecret(ref, db) : undefined;
}

// ---------------------------------------------------------------------------
// Pending authorization flows
// ---------------------------------------------------------------------------

export function createPending(input: CreatePendingInput, db: Db = getDb()): PendingRow {
	const createdAt = nowIso();
	const expiresAt = isoFromNow(input.ttlMs, new Date(createdAt));
	const verifierSealed = input.verifierSealed ?? JSON.stringify(sealSecret(''));

	db.transaction((tx) => {
		// one in-flight flow per upstream: never leave a stale state replayable
		tx.delete(upstreamOauthPending)
			.where(eq(upstreamOauthPending.upstreamId, input.upstreamId))
			.run();
		tx.insert(upstreamOauthPending)
			.values({
				state: input.state,
				upstreamId: input.upstreamId,
				verifierSealed,
				redirectUri: input.redirectUri,
				createdBy: input.createdBy ?? null,
				createdAt,
				expiresAt
			})
			.run();
	});

	const row = getPending(input.state, db);
	if (!row) throw new Error(`pending state ${input.state} was not persisted`);
	return row;
}

export function getPending(state: string, db: Db = getDb()): PendingRow | undefined {
	return db.select().from(upstreamOauthPending).where(eq(upstreamOauthPending.state, state)).get();
}

/**
 * Atomic single-use consume: `delete ... returning` removes the row even when it
 * is expired, and only a non-expired row is returned to the caller. A replay
 * therefore finds nothing.
 */
export function consumePending(state: string, db: Db = getDb()): PendingRow | undefined {
	const row = db
		.delete(upstreamOauthPending)
		.where(eq(upstreamOauthPending.state, state))
		.returning()
		.get();
	if (!row) return undefined;
	if (row.expiresAt <= nowIso()) return undefined;
	return row;
}

export function deletePendingForUpstream(upstreamId: string, db: Db = getDb()): number {
	const removed = db
		.delete(upstreamOauthPending)
		.where(eq(upstreamOauthPending.upstreamId, upstreamId))
		.returning({ state: upstreamOauthPending.state })
		.all();
	return removed.length;
}
