/**
 * Parsing and validation for the upstream form's env mapping (T-32).
 *
 * The same rule as the manifest (BR-09) applies to the UI, otherwise the form
 * would be the easy way to bypass it: a value that looks like a real credential
 * is refused, and operators are pointed at secret storage instead. Literal values
 * remain allowed, because `LOG_LEVEL=debug` is configuration, not a secret.
 */
import { findSecretLike } from '../security/redact.ts';
import { secretExists } from '../governance/secrets.ts';
import { RegistryError } from './index.ts';

export type EnvRow = { env: string; ref: string };

const LINE = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/;

/** Parse `NAME=value` lines. Blank lines and `#` comments are ignored. */
export function parseEnvLines(text: string): { rows: EnvRow[]; errors: string[] } {
	const rows: EnvRow[] = [];
	const errors: string[] = [];
	for (const [index, raw] of text.split('\n').entries()) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const match = LINE.exec(line);
		if (!match) {
			errors.push(`line ${index + 1}: expected NAME=value`);
			continue;
		}
		rows.push({ env: match[1] as string, ref: match[2]!.trim() });
	}
	return { rows, errors };
}

/**
 * Validate one reference.
 *
 * Returns the stored form (`${VAR}` or `secret:<name>`) or throws with an
 * actionable message. A missing secret is an error rather than a warning: an
 * upstream that spawns with a missing token fails inside the child process, which
 * is the worst possible place to discover it.
 */
export function normaliseRef(
	env: string,
	ref: string,
	opts: { allowLiteral?: boolean } = {}
): string {
	if (ref === '')
		throw new RegistryError('empty_ref', `${env}: give a value, \${ENV_VAR}, or secret:<name>`);

	const hostVar = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(ref);
	if (hostVar) {
		const name = hostVar[1] as string;
		if (process.env[name] === undefined || process.env[name] === '') {
			throw new RegistryError(
				'missing_env',
				`${env}: host variable ${name} is not set on this gateway`
			);
		}
		return `\${${name}}`;
	}

	if (ref.startsWith('secret:')) {
		const name = ref.slice('secret:'.length);
		if (!secretExists(ref))
			throw new RegistryError(
				'missing_secret',
				`${env}: secret "${name}" does not exist — create it first`
			);
		return `secret:${name}`;
	}

	const hits = findSecretLike(ref);
	if (hits.length > 0) {
		throw new RegistryError(
			'inlined_secret',
			`${env}: that value looks like a credential (${hits.join(', ')}). Store it as a secret and reference it as secret:<name>`
		);
	}
	if (opts.allowLiteral === false) {
		throw new RegistryError('literal_not_allowed', `${env}: use \${ENV_VAR} or secret:<name> here`);
	}
	return ref;
}

export function rowsToRefs(
	rows: EnvRow[],
	opts: { allowLiteral?: boolean } = {}
): Record<string, string> {
	const refs: Record<string, string> = {};
	for (const row of rows) refs[row.env] = normaliseRef(row.env, row.ref, opts);
	return refs;
}
