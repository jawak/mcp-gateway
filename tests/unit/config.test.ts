import { describe, expect, test } from 'vitest';
import { ConfigError, deriveKey, loadConfig } from '../../src/lib/server/config';

const VALID_KEY = 'a'.repeat(64);

function env(
	overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
	return { MCPGW_MASTER_KEY: VALID_KEY, MCPGW_PUBLIC_URL: 'https://mcp.example.com', ...overrides };
}

function warnings(): { messages: string[]; warn: (m: string) => void } {
	const messages: string[] = [];
	return { messages, warn: (m: string) => messages.push(m) };
}

describe('loadConfig — required secrets', () => {
	test('strict mode refuses to boot without a master key', () => {
		const err = (() => {
			try {
				loadConfig({ mode: 'strict', env: { MCPGW_PUBLIC_URL: 'https://mcp.example.com' } });
				return undefined;
			} catch (error) {
				return error;
			}
		})();
		expect(err).toBeInstanceOf(ConfigError);
		expect((err as ConfigError).issues.join('\n')).toContain('MCPGW_MASTER_KEY');
	});

	test('rejects a master key that is not 32 bytes of hex', () => {
		expect(() => loadConfig({ mode: 'strict', env: env({ MCPGW_MASTER_KEY: 'nothex' }) })).toThrow(
			/64 hex characters/
		);
		expect(() =>
			loadConfig({ mode: 'strict', env: env({ MCPGW_MASTER_KEY: 'a'.repeat(63) }) })
		).toThrow(/64 hex characters/);
	});

	test('rejects a public URL that is not an absolute http(s) origin', () => {
		expect(() =>
			loadConfig({ mode: 'strict', env: env({ MCPGW_PUBLIC_URL: 'mcp.example.com' }) })
		).toThrow(/absolute http\(s\) URL/);
		expect(() => loadConfig({ mode: 'strict', env: env({ MCPGW_PUBLIC_URL: 'ftp://x' }) })).toThrow(
			/absolute http\(s\) URL/
		);
	});

	test('rejects plain http in production but allows it in dev', () => {
		expect(() =>
			loadConfig({
				mode: 'strict',
				env: env({ NODE_ENV: 'production', MCPGW_PUBLIC_URL: 'http://mcp.local' })
			})
		).toThrow(/http:\/\/|TLS/);
		const cfg = loadConfig({
			mode: 'lenient',
			env: env({ MCPGW_PUBLIC_URL: 'http://localhost:8080' })
		});
		expect(cfg.origin).toBe('http://localhost:8080');
	});

	test('NODE_ENV=production selects strict mode automatically', () => {
		expect(() => loadConfig({ env: { NODE_ENV: 'production' } })).toThrow(ConfigError);
	});

	test('lenient mode generates an ephemeral key and warns loudly', () => {
		const { messages, warn } = warnings();
		const cfg = loadConfig({
			mode: 'lenient',
			env: { MCPGW_LOG_LEVEL: 'warn' },
			warn
		});
		expect(cfg.masterKeyIsEphemeral).toBe(true);
		expect(cfg.masterKey).toHaveLength(32);
		expect(messages.join('\n')).toContain('ephemeral key');
		expect(messages.join('\n')).toContain('MCPGW_PUBLIC_URL');
	});
});

describe('loadConfig — coercion and defaults', () => {
	test('applies documented defaults', () => {
		const cfg = loadConfig({ mode: 'strict', env: env() });
		expect(cfg).toMatchObject({
			port: 8080,
			host: '0.0.0.0',
			dataDir: './data',
			logLevel: 'info',
			trustProxy: true,
			maxBodyBytes: 1_048_576,
			healthIntervalMs: 30_000,
			catalogTtlMs: 60_000,
			sessionTtlMs: 1_800_000,
			maxLiveUpstreams: 20,
			upstreamTimeoutMs: 60_000,
			upstreamMaxTimeoutMs: 300_000,
			debugPayload: false,
			timeZone: 'UTC'
		});
		expect(cfg.retention).toEqual({
			toolCallsDays: 30,
			auditDays: 180,
			healthDays: 7,
			backups: 14
		});
	});

	test('names the offending variable when a numeric value is garbage', () => {
		expect(() => loadConfig({ mode: 'strict', env: env({ MCPGW_PORT: 'eighty' }) })).toThrow(
			/MCPGW_PORT/
		);
		expect(() => loadConfig({ mode: 'strict', env: env({ MCPGW_SESSION_TTL_MIN: '0' }) })).toThrow(
			/MCPGW_SESSION_TTL_MIN/
		);
	});

	test('reports every problem at once instead of one per restart', () => {
		try {
			loadConfig({
				mode: 'strict',
				env: env({ MCPGW_PORT: 'x', MCPGW_LOG_LEVEL: 'shout', MCPGW_ADMIN_PASSWORD: 'short' })
			});
			expect.unreachable();
		} catch (error) {
			const issues = (error as ConfigError).issues.join('\n');
			expect(issues).toContain('MCPGW_PORT');
			expect(issues).toContain('MCPGW_LOG_LEVEL');
			expect(issues).toContain('MCPGW_ADMIN_PASSWORD');
		}
	});

	test('parses boolean-ish flags case-insensitively', () => {
		expect(
			loadConfig({ mode: 'strict', env: env({ MCPGW_TRUST_PROXY: 'FALSE' }) }).trustProxy
		).toBe(false);
		expect(loadConfig({ mode: 'strict', env: env({ MCPGW_DEBUG: 'On' }) }).debugPayload).toBe(true);
	});

	test('rejects a default upstream timeout above the hard maximum', () => {
		expect(() =>
			loadConfig({
				mode: 'strict',
				env: env({ MCPGW_UPSTREAM_TIMEOUT_MS: '400000', MCPGW_UPSTREAM_MAX_TIMEOUT_MS: '300000' })
			})
		).toThrow(/cannot exceed/);
	});

	test('rejects a weak metrics token and a malformed admin email', () => {
		expect(() =>
			loadConfig({ mode: 'strict', env: env({ MCPGW_METRICS_TOKEN: 'short' }) })
		).toThrow(/MCPGW_METRICS_TOKEN/);
		expect(() =>
			loadConfig({ mode: 'strict', env: env({ MCPGW_ADMIN_EMAIL: 'not-an-email' }) })
		).toThrow(/MCPGW_ADMIN_EMAIL/);
	});
});

describe('key derivation', () => {
	test('cookie secret is derived deterministically from the master key', () => {
		const a = loadConfig({ mode: 'strict', env: env() }).cookieSecret;
		const b = loadConfig({ mode: 'strict', env: env() }).cookieSecret;
		expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
	});

	test('a different master key yields a different cookie secret', () => {
		const other = loadConfig({ mode: 'strict', env: env({ MCPGW_MASTER_KEY: 'b'.repeat(64) }) });
		const base = loadConfig({ mode: 'strict', env: env() });
		expect(Buffer.from(other.cookieSecret).toString('hex')).not.toBe(
			Buffer.from(base.cookieSecret).toString('hex')
		);
	});

	test('an explicit cookie secret wins', () => {
		const cfg = loadConfig({ mode: 'strict', env: env({ MCPGW_COOKIE_SECRET: 'x'.repeat(40) }) });
		expect(Buffer.from(cfg.cookieSecret).toString('utf8')).toContain('xxxx');
	});

	test('deriveKey domain-separates by info label', () => {
		const key = new Uint8Array(32).fill(7);
		expect(Buffer.from(deriveKey(key, 'a')).toString('hex')).not.toBe(
			Buffer.from(deriveKey(key, 'b')).toString('hex')
		);
		expect(deriveKey(key, 'a', 16)).toHaveLength(16);
	});
});
