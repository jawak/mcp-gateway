/**
 * Secret vault (T-05).
 *
 * Upstream credentials are sealed with AES-256-GCM under a key derived from
 * MCPGW_MASTER_KEY (HKDF-SHA256, domain-separated per key version) and stored as
 * `secret_refs`. Encryption — not hashing — is required because the gateway must
 * hand the credential back to the upstream process; the protection goal is "a
 * database dump or a leaked repo must not reveal credentials".
 *
 * Rotating MCPGW_MASTER_KEY therefore needs a re-seal pass (T-46); `keyVer`
 * exists so old and new ciphertext can coexist during that pass.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { deriveKey, getConfig } from '../config.ts';

export type Sealed = {
	/** base64 ciphertext */
	cipher: string;
	/** base64 12-byte GCM nonce */
	iv: string;
	/** base64 16-byte GCM auth tag */
	tag: string;
	keyVer: number;
};

export class VaultError extends Error {
	readonly reason: 'auth-failed' | 'malformed';

	constructor(reason: 'auth-failed' | 'malformed', detail?: string) {
		super(
			reason === 'auth-failed'
				? 'secret failed authentication — the master key changed or the stored value was tampered with'
				: `stored secret is malformed${detail ? `: ${detail}` : ''}`
		);
		this.name = 'VaultError';
		this.reason = reason;
	}
}

const IV_BYTES = 12;

/** HKDF subkey for one key version; deterministic for a given master key. */
export function vaultKey(masterKey: Uint8Array, keyVer: number): Uint8Array {
	return deriveKey(masterKey, `mcp-gateway/secret/v${keyVer}`, 32);
}

/** Seal plaintext into a storable record. */
export function sealSecret(
	plaintext: string,
	options: { keyVer?: number; masterKey?: Uint8Array } = {}
): Sealed {
	const masterKey = options.masterKey ?? getConfig().masterKey;
	const keyVer = options.keyVer ?? getConfig().masterKeyVersion;
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', vaultKey(masterKey, keyVer), iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return {
		cipher: encrypted.toString('base64'),
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		keyVer
	};
}

/** Recover the plaintext. Throws `VaultError` on tampering or a wrong master key. */
export function openSecret(
	sealed: Pick<Sealed, 'cipher' | 'iv' | 'tag' | 'keyVer'>,
	options: { masterKey?: Uint8Array } = {}
): string {
	const masterKey = options.masterKey ?? getConfig().masterKey;
	let iv: Buffer;
	let tag: Buffer;
	let data: Buffer;
	try {
		iv = Buffer.from(sealed.iv, 'base64');
		tag = Buffer.from(sealed.tag, 'base64');
		data = Buffer.from(sealed.cipher, 'base64');
		if (iv.length !== IV_BYTES || tag.length === 0) throw new Error('unexpected lengths');
	} catch (cause) {
		throw new VaultError('malformed', (cause as Error).message);
	}
	try {
		const decipher = createDecipheriv('aes-256-gcm', vaultKey(masterKey, sealed.keyVer), iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
	} catch {
		throw new VaultError('auth-failed');
	}
}

/** Short, non-reversible fingerprint of the master key (safe to log). */
export function masterKeyId(masterKey: Uint8Array = getConfig().masterKey): string {
	return createHash('sha256').update(masterKey).digest('hex').slice(0, 12);
}
