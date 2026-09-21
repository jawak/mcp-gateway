import { describe, expect, test } from 'bun:test';
import {
	masterKeyId,
	openSecret,
	sealSecret,
	VaultError,
	vaultKey
} from '../../src/lib/server/security/vault';

const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);

describe('vault seal/open', () => {
	test('round-trips a credential', () => {
		const sealed = sealSecret('ghp_1234567890abcdefghij', { masterKey: KEY_A });
		expect(openSecret(sealed, { masterKey: KEY_A })).toBe('ghp_1234567890abcdefghij');
	});

	test('stores no plaintext and never repeats the same ciphertext', () => {
		const secret = 'super-secret-token-value';
		const first = sealSecret(secret, { masterKey: KEY_A });
		const second = sealSecret(secret, { masterKey: KEY_A });
		expect(Buffer.from(first.cipher, 'base64').toString('base64')).not.toContain(secret);
		expect(first.cipher).not.toBe(second.cipher); // fresh nonce per seal
		expect(first.iv).toHaveLength(16); // 12 bytes base64
	});

	test('unicode and empty secrets survive the round trip', () => {
		for (const secret of ['', 'ünïcødé ✓ 日本語', 'x'.repeat(4096)]) {
			expect(openSecret(sealSecret(secret, { masterKey: KEY_A }), { masterKey: KEY_A })).toBe(
				secret
			);
		}
	});

	test('a different master key cannot open the secret', () => {
		const sealed = sealSecret('token-value', { masterKey: KEY_A });
		expect(() => openSecret(sealed, { masterKey: KEY_B })).toThrow(VaultError);
	});

	test('tampering with ciphertext, IV or tag is detected', () => {
		const sealed = sealSecret('token-value', { masterKey: KEY_A });
		const flip = (value: string): string => {
			const bytes = Buffer.from(value, 'base64');
			bytes[0] = bytes[0] ^ 0xff;
			return bytes.toString('base64');
		};
		expect(() =>
			openSecret({ ...sealed, cipher: flip(sealed.cipher) }, { masterKey: KEY_A })
		).toThrow(/authentication/);
		expect(() => openSecret({ ...sealed, iv: flip(sealed.iv) }, { masterKey: KEY_A })).toThrow();
		expect(() => openSecret({ ...sealed, tag: flip(sealed.tag) }, { masterKey: KEY_A })).toThrow();
	});

	test('garbage input reports "malformed" rather than an opaque crypto error', () => {
		expect(() => openSecret({ cipher: '!!!', iv: '!!!', tag: '!!!', keyVer: 1 })).toThrow(
			VaultError
		);
		try {
			openSecret({ cipher: 'aGVsbG8=', iv: 'c2hvcnQ=', tag: '', keyVer: 1 });
			throw new Error('expected throw');
		} catch (error) {
			expect((error as VaultError).reason).toBe('malformed');
		}
	});

	test('key versions derive independent subkeys (rotation window)', () => {
		const sealed = sealSecret('token-value', { masterKey: KEY_A, keyVer: 1 });
		expect(openSecret({ ...sealed, keyVer: 1 }, { masterKey: KEY_A })).toBe('token-value');
		expect(() => openSecret({ ...sealed, keyVer: 2 }, { masterKey: KEY_A })).toThrow();
		expect(Buffer.from(vaultKey(KEY_A, 1)).toString('hex')).not.toBe(
			Buffer.from(vaultKey(KEY_A, 2)).toString('hex')
		);
	});

	test('masterKeyId is stable, short and non-reversible', () => {
		const id = masterKeyId(KEY_A);
		expect(id).toHaveLength(12);
		expect(masterKeyId(KEY_A)).toBe(id);
		expect(masterKeyId(KEY_B)).not.toBe(id);
		expect(id).not.toContain(Buffer.from(KEY_A).toString('hex'));
	});
});
