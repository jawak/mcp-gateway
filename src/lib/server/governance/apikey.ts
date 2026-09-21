/**
 * API key lifecycle (T-21).
 *
 * A key is `mcpgw_` + base58(32 random bytes). The database stores only the
 * SHA-256 hash plus two non-secret display fragments (`key_prefix`,
 * `key_tail4`), so a database dump cannot be used to call the gateway and the
 * dashboard can still show something a user recognises. The plaintext is
 * returned exactly once, at creation or rotation.
 *
 * Status semantics (they map to HTTP codes in the auth middleware, T-22):
 *   - `revoked`  → 401, terminal; rotation is the only way forward
 *   - `suspended`→ 403, reversible (a person is on leave, not leaked)
 *   - expired    → 401, without touching the row's status
 *
 * Revoking or suspending publishes on the event bus so live MCP sessions die
 * within seconds instead of waiting out the idle timeout (FR-03).
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.ts';
import { apiKeys } from '../db/schema.ts';
import { uuidv7 } from '../../shared/ids.ts';
import { isPast, isoFromNow, nowIso } from '../../shared/time.ts';
import { events } from '../registry/events.ts';
import { getProfile } from '../registry/index.ts';
import { recordAudit } from '../observability/audit.ts';
import { RegistryError } from '../registry/index.ts';

export const KEY_PREFIX = 'mcpgw_';
/** base58 without the visually ambiguous 0OIl */
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const KEY_BYTES = 32;
/** Keys created without an explicit expiry stop working after this long. */
export const DEFAULT_VALIDITY_DAYS = 90;

export type ApiKeyRecord = {
	id: string;
	name: string;
	profileId: string;
	status: 'active' | 'suspended' | 'revoked';
	keyPrefix: string;
	keyTail4: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
	ipAllowlist: string[] | null;
	createdAt: string;
	rotatedFromId: string | null;
};

export type CreateKeyInput = {
	name: string;
	profileId: string;
	expiresAt?: string | null;
	ipAllowlist?: string[];
	createdBy?: string | null;
};

export type VerifyOutcome =
	| { ok: true; key: ApiKeyRecord; profileId: string }
	| { ok: false; status: 401 | 403 | 429; reason: VerifyFailure };

export type VerifyFailure =
	| 'missing'
	| 'malformed'
	| 'unknown'
	| 'revoked'
	| 'suspended'
	| 'expired'
	| 'no-profile'
	| 'ip-not-allowed';

export function hashKey(plaintext: string): string {
	return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/** base58 of the raw bytes — no confusing characters when read aloud. */
function base58(bytes: Uint8Array): string {
	const digits = [0];
	for (const byte of bytes) {
		let carry = byte;
		for (let index = 0; index < digits.length; index += 1) {
			carry += digits[index]! << 8;
			digits[index] = carry % 58;
			carry = Math.floor(carry / 58);
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = Math.floor(carry / 58);
		}
	}
	for (const byte of bytes) {
		if (byte !== 0) break;
		digits.push(0);
	}
	return digits
		.reverse()
		.map((digit) => BASE58[digit])
		.join('');
}

/** New plaintext key. Never stored, never logged. */
export function generatePlaintextKey(): string {
	return KEY_PREFIX + base58(new Uint8Array(randomBytes(KEY_BYTES)));
}

/** True when the shape is plausible — cheap rejection before any database work. */
export function looksLikeGatewayKey(value: string): boolean {
	if (!value.startsWith(KEY_PREFIX)) return false;
	const body = value.slice(KEY_PREFIX.length);
	if (body.length < 40 || body.length > 64) return false;
	return [...body].every((char) => BASE58.includes(char));
}

function toRecord(row: typeof apiKeys.$inferSelect): ApiKeyRecord {
	return {
		id: row.id,
		name: row.name,
		profileId: row.profileId,
		status: row.status,
		keyPrefix: row.keyPrefix,
		keyTail4: row.keyTail4,
		expiresAt: row.expiresAt,
		lastUsedAt: row.lastUsedAt,
		ipAllowlist: row.ipAllowlist ?? null,
		createdAt: row.createdAt,
		rotatedFromId: row.rotatedFromId
	};
}

export function createApiKey(
	input: CreateKeyInput,
	options: { db?: Db; ip?: string; requestId?: string; actorId?: string | null } = {}
): { plaintext: string; key: ApiKeyRecord } {
	const db = options.db ?? getDb();
	if (!getProfile(input.profileId)) {
		throw new RegistryError('unknown_profile', `profile ${input.profileId} does not exist`);
	}
	const plaintext = generatePlaintextKey();
	const id = uuidv7();
	const createdAt = nowIso();
	const expiresAt =
		input.expiresAt === undefined
			? isoFromNow(DEFAULT_VALIDITY_DAYS * 86_400_000)
			: input.expiresAt;
	db.insert(apiKeys)
		.values({
			id,
			keyHash: hashKey(plaintext),
			keyPrefix: plaintext.slice(0, 10),
			keyTail4: plaintext.slice(-4),
			name: input.name,
			profileId: input.profileId,
			status: 'active',
			ipAllowlist: input.ipAllowlist?.length ? input.ipAllowlist : null,
			expiresAt,
			createdBy: input.createdBy ?? options.actorId ?? null,
			createdAt
		})
		.run();

	recordAudit({
		actorType: 'user',
		actorId: input.createdBy ?? options.actorId ?? null,
		action: 'apikey.create',
		targetType: 'api_key',
		targetId: id,
		ip: options.ip,
		requestId: options.requestId,
		meta: { name: input.name, profileId: input.profileId, expiresAt },
		db
	});
	return { plaintext, key: getApiKeyById(id, db) as ApiKeyRecord };
}

export function getApiKeyById(id: string, db: Db = getDb()): ApiKeyRecord | undefined {
	const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
	return row ? toRecord(row) : undefined;
}

/** Keys for the dashboard. Hashes are never selected. */
export function listApiKeys(db: Db = getDb()): ApiKeyRecord[] {
	return db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all().map(toRecord);
}

/** Used by the delete guard message in the dashboard (BR-08). */
export function activeKeysForProfile(profileId: string, db: Db = getDb()): ApiKeyRecord[] {
	return db
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.profileId, profileId), eq(apiKeys.status, 'active')))
		.all()
		.filter((row) => !isPast(row.expiresAt))
		.map(toRecord);
}

/**
 * Resolve a bearer token to a usable key.
 *
 * The hash is computed first so the expensive step happens for every attempt,
 * then a single indexed lookup decides existence — the only thing timing reveals
 * is whether a *valid 256-bit key* exists, which a guesser cannot know.
 */
export async function verifyApiKey(
	headerValue: string | null,
	options: { ip?: string; db?: Db } = {}
): Promise<VerifyOutcome> {
	const db = options.db ?? getDb();
	if (!headerValue) return { ok: false, status: 401, reason: 'missing' };
	const token =
		headerValue.startsWith('Bearer ') || headerValue.startsWith('bearer ')
			? headerValue.slice(7).trim()
			: headerValue.trim();
	if (!looksLikeGatewayKey(token)) return { ok: false, status: 401, reason: 'malformed' };

	const row = db
		.select()
		.from(apiKeys)
		.where(eq(apiKeys.keyHash, hashKey(token)))
		.get();
	if (!row) return { ok: false, status: 401, reason: 'unknown' };
	const key = toRecord(row);
	if (key.status === 'revoked') return { ok: false, status: 401, reason: 'revoked' };
	if (key.status === 'suspended') return { ok: false, status: 403, reason: 'suspended' };
	if (isPast(key.expiresAt)) return { ok: false, status: 401, reason: 'expired' };
	if (!getProfile(key.profileId)) return { ok: false, status: 401, reason: 'no-profile' };
	if (
		key.ipAllowlist &&
		key.ipAllowlist.length > 0 &&
		options.ip &&
		!ipMatches(options.ip, key.ipAllowlist)
	) {
		return { ok: false, status: 403, reason: 'ip-not-allowed' };
	}
	return { ok: true, key, profileId: key.profileId };
}

/** Exact match plus a cheap ` CIDR`-free prefix form (`10.0.0.` style). */
export function ipMatches(ip: string, allowlist: string[]): boolean {
	return allowlist.some((entry) =>
		entry.includes('/')
			? ipInCidr(ip, entry)
			: entry.endsWith('.')
				? ip.startsWith(entry)
				: ip === entry
	);
}

function ipInCidr(ip: string, cidr: string): boolean {
	const [base = '', bits = ''] = cidr.split('/');
	const width = Number.parseInt(bits, 10);
	if (!Number.isFinite(width) || width < 0 || width > 32) return false;
	const toInt = (value: string): number | undefined => {
		const parts = value.split('.').map((part) => Number.parseInt(part, 10));
		if (
			parts.length !== 4 ||
			parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)
		)
			return undefined;
		return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
	};
	const a = toInt(ip);
	const b = toInt(base);
	if (a === undefined || b === undefined) return false;
	const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
	return (a & mask) === (b & mask);
}

/** Record that a key was used, throttled by the caller (T-22). */
export function touchApiKey(id: string, db: Db = getDb()): void {
	db.update(apiKeys).set({ lastUsedAt: nowIso() }).where(eq(apiKeys.id, id)).run();
}

function existingOwner(db: Db, id: string): string | null {
	return (
		db.select({ createdBy: apiKeys.createdBy }).from(apiKeys).where(eq(apiKeys.id, id)).get()
			?.createdBy ?? null
	);
}

type StatusChange = { db?: Db; ip?: string; requestId?: string; actorId?: string | null };

function setStatus(
	id: string,
	status: ApiKeyRecord['status'],
	action: string,
	options: StatusChange
): ApiKeyRecord {
	const db = options.db ?? getDb();
	const existing = getApiKeyById(id, db);
	if (!existing) throw new RegistryError('not_found', 'api key not found');
	db.update(apiKeys)
		.set({ status, ...(status === 'revoked' ? { revokedAt: nowIso() } : {}) } as never)
		.where(eq(apiKeys.id, id))
		.run();
	recordAudit({
		actorType: 'user',
		actorId: options.actorId ?? null,
		action,
		targetType: 'api_key',
		targetId: id,
		ip: options.ip,
		requestId: options.requestId,
		meta: { name: existing.name, from: existing.status, to: status },
		db
	});
	return getApiKeyById(id, db) as ApiKeyRecord;
}

/** FR-03: terminal, and live sessions die immediately. */
export function revokeApiKey(id: string, options: StatusChange = {}): ApiKeyRecord {
	const key = setStatus(id, 'revoked', 'apikey.revoke', options);
	events.emit('key.revoked', { keyId: id });
	return key;
}

export function suspendApiKey(id: string, options: StatusChange = {}): ApiKeyRecord {
	const key = setStatus(id, 'suspended', 'apikey.suspend', options);
	events.emit('key.suspended', { keyId: id });
	return key;
}

export function resumeApiKey(id: string, options: StatusChange = {}): ApiKeyRecord {
	const existing = getApiKeyById(id, options.db);
	if (!existing) throw new RegistryError('not_found', 'api key not found');
	if (existing.status === 'revoked') {
		throw new RegistryError(
			'revoked_is_terminal',
			'a revoked key cannot be resumed — rotate it instead'
		);
	}
	return setStatus(id, 'active', 'apikey.resume', options);
}

/** New secret, same scope: profile, limits and IP allowlist are copied over. */
export function rotateApiKey(
	id: string,
	options: StatusChange = {}
): { plaintext: string; key: ApiKeyRecord } {
	const db = options.db ?? getDb();
	const existing = getApiKeyById(id, db);
	if (!existing) throw new RegistryError('not_found', 'api key not found');
	if (existing.status === 'revoked') {
		throw new RegistryError(
			'revoked_is_terminal',
			'a revoked key cannot be rotated — create a new one'
		);
	}
	const plaintext = generatePlaintextKey();
	const newId = uuidv7();
	const createdAt = nowIso();
	db.insert(apiKeys)
		.values({
			id: newId,
			keyHash: hashKey(plaintext),
			keyPrefix: plaintext.slice(0, 10),
			keyTail4: plaintext.slice(-4),
			name: existing.name,
			profileId: existing.profileId,
			status: 'active',
			ipAllowlist: existing.ipAllowlist,
			expiresAt: existing.expiresAt,
			// the rotation inherits the original owner so attribution survives
			createdBy: existingOwner(db, id),
			createdAt,
			rotatedFromId: id
		})
		.run();
	setStatus(id, 'revoked', 'apikey.rotate', { ...options, requestId: options.requestId });
	recordAudit({
		actorType: 'user',
		actorId: options.actorId ?? null,
		action: 'apikey.rotate',
		targetType: 'api_key',
		targetId: newId,
		ip: options.ip,
		requestId: options.requestId,
		meta: { from: id, profileId: existing.profileId },
		db
	});
	// the old secret must stop working now, not when its sessions idle out
	events.emit('key.revoked', { keyId: id });
	return { plaintext, key: getApiKeyById(newId, db) as ApiKeyRecord };
}

export function setIpAllowlist(
	id: string,
	allowlist: string[],
	options: StatusChange = {}
): ApiKeyRecord {
	const db = options.db ?? getDb();
	const existing = getApiKeyById(id, db);
	if (!existing) throw new RegistryError('not_found', 'api key not found');
	db.update(apiKeys)
		.set({ ipAllowlist: allowlist.length > 0 ? allowlist : null })
		.where(eq(apiKeys.id, id))
		.run();
	recordAudit({
		actorType: 'user',
		actorId: options.actorId ?? null,
		action: 'apikey.set_ip_allowlist',
		targetType: 'api_key',
		targetId: id,
		ip: options.ip,
		requestId: options.requestId,
		meta: { allowlist },
		db
	});
	return getApiKeyById(id, db) as ApiKeyRecord;
}

/** Keys whose profile is still referenced but no longer usable, for the UI. */
export function keysPointingAtMissingProfile(db: Db = getDb()): ApiKeyRecord[] {
	return db
		.select()
		.from(apiKeys)
		.where(eq(apiKeys.status, 'active'))
		.orderBy(desc(apiKeys.createdAt))
		.all()
		.map(toRecord)
		.filter((key) => !getProfile(key.profileId));
}
