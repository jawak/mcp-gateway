import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_VALIDITY_DAYS,
	KEY_PREFIX,
	generatePlaintextKey,
	hashKey,
	ipMatches,
	looksLikeGatewayKey
} from '../../src/lib/server/governance/apikey';

describe('key format', () => {
	test('starts with the gateway prefix and uses an unambiguous alphabet', () => {
		const key = generatePlaintextKey();
		expect(key.startsWith(KEY_PREFIX)).toBe(true);
		const body = key.slice(KEY_PREFIX.length);
		expect(body.length).toBeGreaterThanOrEqual(40);
		// base58 drops 0OIl so a key read over a call cannot be mistyped
		expect(/[0OIl]/.test(body)).toBe(false);
		expect([...body].every((char) => !/[^A-Za-z0-9]/.test(char))).toBe(true);
	});

	test('1000 keys are unique and 256 bits of entropy is not obviously short', () => {
		const keys = new Set<string>();
		for (let index = 0; index < 1000; index += 1) keys.add(generatePlaintextKey());
		expect(keys.size).toBe(1000);
		// a 32-byte key in base58 encodes to ~43-44 characters
		expect(generatePlaintextKey().length - KEY_PREFIX.length >= 42).toBe(true);
	});

	test('the shape check accepts good keys and rejects everything else', () => {
		expect(looksLikeGatewayKey(generatePlaintextKey())).toBe(true);
		expect(looksLikeGatewayKey('sk-live-aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
		expect(looksLikeGatewayKey('mcpgw_short')).toBe(false);
		expect(looksLikeGatewayKey('mcpgw_' + 'a'.repeat(50))).toBe(true); // shape only, not validity
		expect(looksLikeGatewayKey('mcpgw_' + '0OIl'.repeat(12))).toBe(false);
		expect(looksLikeGatewayKey('')).toBe(false);
	});

	test('a malformed key is rejected before any database lookup is possible', () => {
		// documented contract of verifyApiKey(): these two are indistinguishable to
		// the caller, so a probe cannot tell "wrong key" from "not a gateway key"
		expect(looksLikeGatewayKey('hunter2')).toBe(false);
		expect(looksLikeGatewayKey(generatePlaintextKey().slice(0, -1) + '0')).toBe(false);
	});
});

describe('hashKey', () => {
	test('is deterministic, hex, and reveals nothing about the input', () => {
		const key = generatePlaintextKey();
		const hash = hashKey(key);
		expect(hash).toBe(hashKey(key));
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hash).not.toContain(key.slice(KEY_PREFIX.length, KEY_PREFIX.length + 4));
	});

	test('different keys hash differently', () => {
		expect(hashKey(generatePlaintextKey())).not.toBe(hashKey(generatePlaintextKey()));
	});
});

describe('ipMatches', () => {
	test('exact and prefix forms', () => {
		expect(ipMatches('203.0.113.7', ['203.0.113.7'])).toBe(true);
		expect(ipMatches('203.0.113.7', ['203.0.113.8'])).toBe(false);
		expect(ipMatches('10.0.0.44', ['10.0.0.'])).toBe(true);
		expect(ipMatches('10.1.0.44', ['10.0.0.'])).toBe(false);
	});

	test('CIDR ranges', () => {
		expect(ipMatches('10.0.0.44', ['10.0.0.0/24'])).toBe(true);
		expect(ipMatches('10.0.1.44', ['10.0.0.0/24'])).toBe(false);
		expect(ipMatches('192.168.5.5', ['192.168.0.0/16'])).toBe(true);
		expect(ipMatches('192.169.5.5', ['192.168.0.0/16'])).toBe(false);
		expect(ipMatches('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
	});

	test('a broken range never grants access', () => {
		expect(ipMatches('10.0.0.1', ['10.0.0.0/33'])).toBe(false);
		expect(ipMatches('10.0.0.1', ['not-an-ip/24'])).toBe(false);
		expect(ipMatches('garbage', ['10.0.0.0/24'])).toBe(false);
	});

	test('any matching entry is enough', () => {
		expect(ipMatches('203.0.113.9', ['10.0.0.0/8', '203.0.113.9'])).toBe(true);
	});
});

describe('defaults', () => {
	test('a key without an explicit expiry still expires', () => {
		expect(DEFAULT_VALIDITY_DAYS).toBe(90);
	});
});
