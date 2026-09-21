/**
 * Secret storage (T-05 surface, used by upstream spawn, tests and the UI).
 *
 * Values are sealed with the master key and stored as ciphertext; the plaintext
 * is only ever materialised into a child process environment or an outbound
 * header, never returned from an API route or written to a log.
 *
 * Names are referenced from configuration (`secret:<name>`), so a secret can be
 * rotated in place without editing every upstream that uses it.
 */
import { eq } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.ts';
import { secretRefs, upstreams } from '../db/schema.ts';
import { sealSecret, openSecret, VaultError } from '../security/vault.ts';
import { uuidv7 } from '../../shared/ids.ts';
import { nowIso } from '../../shared/time.ts';
import { recordAudit } from '../observability/audit.ts';
import { RegistryError } from '../registry/index.ts';

export const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function isSecretRef(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	return value.startsWith('secret:') ? value.slice('secret:'.length) : undefined;
}

/** Resolve a `secret:<name>` reference. Returns undefined when it does not exist. */
export function openSecretByName(nameOrRef: string): string | undefined {
	const name = isSecretRef(nameOrRef) ?? nameOrRef;
	if (!SECRET_NAME_PATTERN.test(name)) return undefined;
	const row = getDb().select().from(secretRefs).where(eq(secretRefs.name, name)).get();
	if (!row) return undefined;
	try {
		return openSecret({ cipher: row.cipher, iv: row.iv, tag: row.tag, keyVer: row.keyVer });
	} catch (error) {
		if (error instanceof VaultError) {
			// a rotated master key must be loud: every upstream depending on a secret
			// is about to look "broken" while the real cause is here
			recordAudit({
				actorType: 'system',
				action: 'secret.vault_error',
				targetType: 'secret',
				targetId: name,
				meta: { reason: error.reason }
			});
		}
		return undefined;
	}
}

export type SecretSummary = { name: string; createdAt: string; rotatedAt: string | null };

/** Names and timestamps only — there is no read path for the value by design. */
export function listSecrets(db: Db = getDb()): SecretSummary[] {
	return db
		.select()
		.from(secretRefs)
		.all()
		.map((row) => ({ name: row.name, createdAt: row.createdAt, rotatedAt: row.rotatedAt }));
}

export function putSecret(
	name: string,
	value: string,
	options: { actorId?: string | null; ip?: string | null; requestId?: string | null; db?: Db } = {}
): SecretSummary {
	const db = options.db ?? getDb();
	if (!SECRET_NAME_PATTERN.test(name)) {
		throw new RegistryError(
			'invalid_secret_name',
			'secret names use lowercase letters, digits, "-" or "_" (2-64 chars)'
		);
	}
	if (value.length === 0) throw new RegistryError('empty_secret', 'a secret value cannot be empty');

	const sealed = sealSecret(value);
	const existing = db.select().from(secretRefs).where(eq(secretRefs.name, name)).get();
	if (existing) {
		db.update(secretRefs)
			.set({
				cipher: sealed.cipher,
				iv: sealed.iv,
				tag: sealed.tag,
				keyVer: sealed.keyVer,
				rotatedAt: nowIso()
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
				createdAt: nowIso()
			})
			.run();
	}

	// the name is safe to log; the value never is
	recordAudit({
		actorType: 'user',
		actorId: options.actorId ?? null,
		action: existing ? 'secret.rotate' : 'secret.create',
		targetType: 'secret',
		targetId: name,
		ip: options.ip ?? null,
		requestId: options.requestId ?? null,
		db
	});
	return {
		name,
		createdAt: existing?.createdAt ?? nowIso(),
		rotatedAt: existing ? nowIso() : null
	};
}

/**
 * Delete a secret. Refuses while an upstream still references it: leaving a
 * dangling reference would turn that upstream into a confusing "unconfigured"
 * failure at its next spawn instead of failing here with a clear message.
 */
export function deleteSecret(
	name: string,
	options: { actorId?: string | null; ip?: string | null; requestId?: string | null; db?: Db } = {}
): void {
	const db = options.db ?? getDb();
	const referencing = db
		.select()
		.from(upstreams)
		.all()
		.filter(
			(row) =>
				Object.values(row.envRefs ?? {}).some((ref) => isSecretRef(ref) === name) ||
				isSecretRef((row.connection as { authRef?: string } | null)?.authRef) === name ||
				row.headersRef === name
		);
	if (referencing.length > 0) {
		throw new RegistryError(
			'secret_in_use',
			`still referenced by: ${[...new Set(referencing.map((row) => row.slug))].join(', ')} — repoint those upstreams first`
		);
	}
	db.delete(secretRefs).where(eq(secretRefs.name, name)).run();
	recordAudit({
		actorType: 'user',
		actorId: options.actorId ?? null,
		action: 'secret.delete',
		targetType: 'secret',
		targetId: name,
		ip: options.ip ?? null,
		requestId: options.requestId ?? null,
		db
	});
}

/** True when the reference resolves — used to explain an `unconfigured` badge. */
export function secretExists(nameOrRef: string): boolean {
	return openSecretByName(nameOrRef) !== undefined;
}
