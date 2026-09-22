/**
 * Environment reference resolution (T-05).
 *
 * An upstream never stores credentials inline (BR-09). `upstreams.env_refs` maps
 * an environment variable name to a reference:
 *
 *   GITHUB_TOKEN  → "secret:github-token"   sealed in `secret_refs`
 *   SENTRY_URL    → "${SENTRY_URL}"         read from the gateway process env
 *   LOG_LEVEL     → "debug"                 plain literal (non-secret config)
 *
 * Resolution happens at spawn time, inside this process: plaintext secrets never
 * touch the database, the API, the logs, or the dashboard.
 */
import { findSecretLike, redactString } from './redact.ts';

export type Ref =
	| { kind: 'secret'; name: string }
	| { kind: 'env'; name: string }
	| { kind: 'literal'; value: string };

const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const SECRET_REF_RE = /^secret:([a-z0-9][a-z0-9_-]{1,63})$/i;

export function parseRef(ref: string): Ref {
	const secret = SECRET_REF_RE.exec(ref);
	if (secret) return { kind: 'secret', name: secret[1] as string };
	const env = ENV_REF_RE.exec(ref);
	if (env) return { kind: 'env', name: env[1] as string };
	return { kind: 'literal', value: ref };
}

export function secretRef(name: string): string {
	if (!SECRET_REF_RE.test(`secret:${name}`)) {
		throw new Error(`invalid secret name "${name}" (use lowercase letters, digits, "-" or "_")`);
	}
	return `secret:${name}`;
}

export function envRef(name: string): string {
	return `\${${name}}`;
}

/**
 * Does this reference value look like a credential typed in directly?
 *
 * Only literal values are examined. `secret:...` and `${...}` are references by
 * construction — and `findSecretLike` fires on the colon in `secret:pg-dev__url`, so
 * checking references as well would reject every legitimate secret reference in the
 * database. That ordering is the whole trick; the rest of the codebase relies on it.
 *
 * Used at the registry boundary rather than only in the dashboard form, so that any
 * caller — template install, manifest apply, a future API — is held to the same rule.
 */
export function credentialLookingRef(ref: string): string[] {
	if (typeof ref !== 'string' || ref === '') return [];
	if (parseRef(ref).kind !== 'literal') return [];
	return findSecretLike(ref);
}

export type ResolveDeps = {
	/** Defaults to `process.env`. */
	readEnv?: (name: string) => string | undefined;
	/** Opens a `secret:` reference; throws when the row or key is unusable. */
	openSecret?: (name: string) => string | undefined;
};

export type ResolvedEnv = {
	values: Record<string, string>;
	/** Env names the upstream needs but that cannot be resolved right now. */
	missing: Array<{
		env: string;
		ref: string;
		reason: 'no-such-env' | 'no-such-secret' | 'vault-error';
	}>;
};

/**
 * Resolve a whole `env_refs` map. Missing references are reported instead of
 * throwing, because an unconfigured upstream must be shown as `unconfigured` in
 * the dashboard rather than crashing the gateway (FR-05).
 */
export function resolveEnvRefs(refs: Record<string, string>, deps: ResolveDeps = {}): ResolvedEnv {
	const readEnv = deps.readEnv ?? ((name: string) => process.env[name]);
	const values: Record<string, string> = {};
	const missing: ResolvedEnv['missing'] = [];

	for (const [env, ref] of Object.entries(refs)) {
		const parsed = parseRef(ref);
		if (parsed.kind === 'literal') {
			values[env] = parsed.value;
			continue;
		}
		if (parsed.kind === 'env') {
			const value = readEnv(parsed.name);
			if (value === undefined || value === '') {
				missing.push({ env, ref, reason: 'no-such-env' });
				continue;
			}
			values[env] = value;
			continue;
		}
		if (!deps.openSecret) {
			missing.push({ env, ref, reason: 'no-such-secret' });
			continue;
		}
		try {
			const value = deps.openSecret(parsed.name);
			if (value === undefined) {
				missing.push({ env, ref, reason: 'no-such-secret' });
			} else {
				values[env] = value;
			}
		} catch {
			// a rotated/renamed master key must not take the whole gateway down
			missing.push({ env, ref, reason: 'vault-error' });
		}
	}
	return { values, missing };
}

/** Env vars handed to a spawned upstream; anything else (master key, DSNs) stays here. */
export const SPAWN_ENV_ALLOWLIST = [
	'PATH',
	'HOME',
	'LANG',
	'LC_ALL',
	'NODE_ENV',
	'TMPDIR',
	'SHELL',
	'USER'
] as const;

/** Minimal, sanitised base environment for `StdioClientTransport`. */
export function baseProcessEnv(
	source: Record<string, string | undefined> = process.env
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of SPAWN_ENV_ALLOWLIST) {
		const value = source[key];
		if (value !== undefined && value !== '') out[key] = value;
	}
	return out;
}

/** Message shown in the dashboard when an upstream cannot start. */
export function describeMissing(missing: ResolvedEnv['missing']): string {
	return missing
		.map((item) => {
			switch (item.reason) {
				case 'no-such-env':
					return `env ${item.env} is not set on the gateway host (referenced by ${item.ref})`;
				case 'no-such-secret':
					return `secret ${redactString(item.ref)} for env ${item.env} is missing — add it in the upstream form`;
				case 'vault-error':
					return `secret for env ${item.env} could not be decrypted — MCPGW_MASTER_KEY may have changed`;
			}
		})
		.join('; ');
}
