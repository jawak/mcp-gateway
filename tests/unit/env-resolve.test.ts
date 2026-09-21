import { describe, expect, test } from 'bun:test';
import {
	baseProcessEnv,
	describeMissing,
	envRef,
	parseRef,
	resolveEnvRefs,
	secretRef,
	SPAWN_ENV_ALLOWLIST
} from '../../src/lib/server/security/env-resolve';

describe('parseRef', () => {
	test('recognises the three reference forms', () => {
		expect(parseRef('secret:github-token')).toEqual({ kind: 'secret', name: 'github-token' });
		expect(parseRef('${SENTRY_URL}')).toEqual({ kind: 'env', name: 'SENTRY_URL' });
		expect(parseRef('debug')).toEqual({ kind: 'literal', value: 'debug' });
		// anything that is not an exact ${VAR} is a literal, never a sneaky lookup
		expect(parseRef('prefix-${HOST}')).toEqual({ kind: 'literal', value: 'prefix-${HOST}' });
	});

	test('helpers produce refs that parse back', () => {
		expect(parseRef(secretRef('sentry_dsn'))).toEqual({ kind: 'secret', name: 'sentry_dsn' });
		expect(parseRef(envRef('PG_DSN'))).toEqual({ kind: 'env', name: 'PG_DSN' });
		expect(() => secretRef('Bad Name!')).toThrow(/invalid secret name/);
	});
});

describe('resolveEnvRefs', () => {
	const deps = {
		readEnv: (name: string) =>
			(({ HOST_TOKEN: 'from-host', EMPTY: '' }) as Record<string, string>)[name],
		openSecret: (name: string) => (name === 'github-token' ? 'vault-value' : undefined)
	};

	test('resolves host env, vault secrets and literals', () => {
		const resolved = resolveEnvRefs(
			{
				GH_TOKEN: '${HOST_TOKEN}',
				SENTRY_TOKEN: 'secret:github-token',
				LOG_LEVEL: 'debug'
			},
			deps
		);
		expect(resolved.values).toEqual({
			GH_TOKEN: 'from-host',
			SENTRY_TOKEN: 'vault-value',
			LOG_LEVEL: 'debug'
		});
		expect(resolved.missing).toEqual([]);
	});

	test('reports missing refs instead of throwing (upstream becomes unconfigured)', () => {
		const resolved = resolveEnvRefs(
			{
				A: '${NOT_SET}',
				B: '${EMPTY}', // present but empty counts as unset
				C: 'secret:missing-secret',
				D: 'secret:github-token'
			},
			{
				readEnv: () => '',
				openSecret: (name: string) => (name === 'github-token' ? 'v' : undefined)
			}
		);
		expect(resolved.missing.map((m) => [m.env, m.reason])).toEqual([
			['A', 'no-such-env'],
			['B', 'no-such-env'],
			['C', 'no-such-secret']
		]);
		expect(resolved.values).toEqual({ D: 'v' });
	});

	test('a broken vault does not take the gateway down', () => {
		const resolved = resolveEnvRefs(
			{ X: 'secret:github-token' },
			{
				openSecret: () => {
					throw new Error('master key changed');
				}
			}
		);
		expect(resolved.missing).toEqual([
			{ env: 'X', ref: 'secret:github-token', reason: 'vault-error' }
		]);
		expect(describeMissing(resolved.missing)).toContain('MCPGW_MASTER_KEY');
	});

	test('a vault secret with no opener configured is reported, not silently dropped', () => {
		const resolved = resolveEnvRefs({ X: 'secret:github-token' }, { readEnv: () => 'unused' });
		expect(resolved.missing[0].reason).toBe('no-such-secret');
	});

	test('describeMissing names the env var the operator has to set', () => {
		const message = describeMissing([
			{ env: 'SENTRY_TOKEN', ref: '${SENTRY_URL}', reason: 'no-such-env' }
		]);
		expect(message).toContain('SENTRY_TOKEN');
		expect(message).toContain('SENTRY_URL');
	});
});

describe('spawn environment hygiene', () => {
	test('only the allowlist survives', () => {
		const env = baseProcessEnv({
			PATH: '/usr/bin',
			HOME: '/var/lib/mcpgw',
			NODE_ENV: 'production',
			MCPGW_MASTER_KEY: 'a'.repeat(64),
			DATABASE_URL: 'postgres://user:pass@db/prod',
			AWS_SECRET_ACCESS_KEY: 'zzz',
			EMPTY: ''
		});
		expect(env).toEqual({ PATH: '/usr/bin', HOME: '/var/lib/mcpgw', NODE_ENV: 'production' });
		expect(Object.keys(env)).not.toContain('MCPGW_MASTER_KEY');
	});

	test('the allowlist itself never contains a secret-shaped name', () => {
		for (const key of SPAWN_ENV_ALLOWLIST) {
			expect(/key|secret|token|password|dsn|url/i.test(key), key).toBe(false);
		}
	});
});
