import { describe, expect, test } from 'bun:test';
import {
	findSecretLike,
	isSecretKey,
	REDACTED,
	redactString,
	redactValue
} from '../../src/lib/server/security/redact';

const GITHUB = 'ghp_16CharactersPlusMore000000';
const FINE = 'fetched 12 issues from octocat/hello-world in 84ms';

describe('redactString', () => {
	test('leaves ordinary tool output untouched', () => {
		expect(redactString(FINE)).toBe(FINE);
	});

	const cases: Array<[string, string]> = [
		['github pat', `token is ${GITHUB}`],
		['github fine-grained', 'auth github_pat_11ABCDEF0abcdef_ABCDEFabcdef123456'],
		['slack', 'xoxb-1234567890-abcdefghij'],
		['openai', 'sk-proj-abcdefghijklmnopqrstuvwxyz'],
		['anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
		['google', 'AIzaSyA1234567890abcdefghijklmnopqrstuvw'],
		['aws', 'AKIAIOSFODNN7EXAMPLE'],
		['gitlab', 'glpat-AbCdEf1234567890'],
		['npm', `npm_${'a'.repeat(36)}`],
		// built from parts like the npm fixture above: a literal live-shaped token trips
		// GitHub push protection on every push — do not "simplify" this back to a string
		['stripe', `sk_live_${'a'.repeat(26)}`],
		[
			'jwt',
			'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
		],
		['basic auth url', 'postgres://admin:hunter2@db.internal:5432/prod'],
		['bearer header', 'Authorization: Bearer abcdef1234567890'],
		['gateway key', 'connect with mcpgw_abcdefghij1234'],
		['assignment', 'GITHUB_TOKEN=ghp_notAMatchButAssigned0000'],
		[
			'private key block',
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
		]
	];

	for (const [name, input] of cases) {
		test(`redacts ${name}`, () => {
			const output = redactString(input);
			expect(output).toContain(REDACTED);
			// the secret itself must be gone; short fragments (prefixes) may remain by design
			expect(output).not.toContain(input.split(/[=\s]/).at(-1)?.slice(0, 24) ?? '\u0000');
		});
	}

	test('keeps the key name of an assignment so logs stay diagnosable', () => {
		const output = redactString('GITHUB_TOKEN=abc123def456ghi789');
		expect(output).toMatch(/GITHUB_TOKEN[=:]\[redacted\]/);
		expect(output).not.toContain('abc123def456ghi789');
	});

	test('redacts every occurrence', () => {
		const output = redactString(`${GITHUB} and again ${GITHUB}`);
		expect(output.split(REDACTED).length - 1).toBe(2);
	});
});

describe('redactValue', () => {
	test('masks secrets nested in objects and arrays', () => {
		const redacted = redactValue({
			message: `clone failed with ${GITHUB}`,
			headers: { authorization: 'Bearer zzzzzzzzzzzzzzzzzzzz' },
			items: [{ token: 'a'.repeat(30) }, 'plain'],
			durationMs: 12
		}) as Record<string, unknown>;
		expect(String(redacted.message)).toContain(REDACTED);
		expect(redacted.headers).toEqual({ authorization: REDACTED });
		expect((redacted.items as Array<unknown>)[0]).toEqual({ token: REDACTED });
		expect((redacted.items as Array<string>)[1]).toBe('plain');
		expect(redacted.durationMs).toBe(12);
	});

	test('serialises errors without leaking their message', () => {
		const redacted = redactValue(new Error(`auth failed for ${GITHUB}`)) as { message: string };
		expect(redacted.message).toContain(REDACTED);
		expect(redacted.message).not.toContain(GITHUB);
	});

	test('does not inline binary payloads', () => {
		expect(redactValue(new Uint8Array(64))).toBe('[binary 64B]');
	});

	test('clips pathological depth and size', () => {
		let deep: Record<string, unknown> = { end: 'x' };
		for (let i = 0; i < 40; i += 1) deep = { nested: deep };
		const result = JSON.stringify(redactValue(deep));
		expect(result).toContain('[truncated]');

		const huge = redactValue(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
		expect(huge.length).toBeLessThanOrEqual(51);

		const longString = redactValue({ text: 'a'.repeat(50_000) }) as { text: string };
		expect(longString.text.length).toBeLessThan(2100);
	});

	test('isSecretKey covers the usual suspects', () => {
		for (const key of [
			'token',
			'access_token',
			'x_api_key',
			'password',
			'client_secret',
			'authorization',
			'cookie'
		]) {
			expect(isSecretKey(key), key).toBe(true);
		}
		for (const key of ['hostname', 'repository', 'tokenizer', 'secret_count', 'status']) {
			expect(isSecretKey(key), key).toBe(false);
		}
	});
});

describe('findSecretLike (manifest import guard)', () => {
	test('names the patterns it matched', () => {
		expect(findSecretLike(`env:\n  GITHUB_TOKEN: ${GITHUB}`)).toContain('github-token');
		expect(findSecretLike('password: hunter2hunter2')).toContain('assignment');
		expect(findSecretLike('name: my-mcp-server')).toEqual([]);
	});

	test('is repeatable (no shared /g lastIndex state)', () => {
		const input = `token ${GITHUB}`;
		expect(findSecretLike(input)).toEqual(findSecretLike(input));
		expect(findSecretLike(input).length).toBeGreaterThan(0);
	});
});
