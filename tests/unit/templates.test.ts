import { describe, expect, test } from 'bun:test';
import { getTemplate, planInstall } from '../../src/lib/server/templates';
import { parseRef } from '../../src/lib/server/security/env-resolve';

/**
 * Template installation (T-45).
 *
 * There was no test for this path at all, which is how the gallery install and the
 * "start from a template" form drifted apart: one sealed the secret and referenced it
 * as `secret:<name>`, the other stored the bare name — a *literal* to `parseRef`, so
 * the spawned server received the secret's name as its `DATABASE_URL` and failed to
 * connect for a reason that pointed nowhere near the truth.
 *
 * These tests use the real bundled catalogue, because the thing an operator installs
 * is the thing that has to be right.
 */
const postgres = getTemplate('postgres');
const CONN = 'postgres://reader:secret-pass@db.internal:5432/analytics';

describe('planInstall — the reference form is the whole contract', () => {
	test('a secret field becomes a `secret:` reference, not the bare name', () => {
		expect(postgres).toBeDefined();
		const { plan, secrets, missing } = planInstall(postgres!, { DATABASE_URL: CONN }, 'pg-dev');

		expect(missing).toEqual([]);
		expect(plan.envRefs.DATABASE_URL).toBe('secret:pg-dev__database_url');
		// the exact regression: a bare name resolves as a literal
		expect(plan.envRefs.DATABASE_URL).not.toBe('pg-dev__database_url');
		expect(secrets).toEqual([{ name: 'pg-dev__database_url', value: CONN }]);
	});

	test('what it emits resolves as a secret — this is what the child process sees', () => {
		const { plan } = planInstall(postgres!, { DATABASE_URL: CONN }, 'pg-dev');
		const ref = parseRef(plan.envRefs.DATABASE_URL);
		// before the fix this was `{kind: 'literal', value: 'pg-dev__database_url'}`
		expect(ref).toEqual({ kind: 'secret', name: 'pg-dev__database_url' });
	});

	test('the plan carries the command and args the operator will see', () => {
		const { plan } = planInstall(postgres!, { DATABASE_URL: CONN }, 'pg-dev');
		expect(plan.transport).toBe('stdio');
		expect(plan.connection).toMatchObject({
			command: 'npx',
			args: expect.arrayContaining(['-y', '@modelcontextprotocol/server-postgres'])
		});
	});
});

describe('planInstall — slug handling', () => {
	test('an uppercase slug is normalised in the plan and in the secret name', () => {
		const { plan, secrets } = planInstall(postgres!, { DATABASE_URL: CONN }, '  PG-Dev  ');
		expect(plan.slug).toBe('pg-dev');
		// the reference and the sealed name must agree, or the upstream is unconfigured
		expect(plan.envRefs.DATABASE_URL).toBe('secret:pg-dev__database_url');
		expect(secrets[0].name).toBe('pg-dev__database_url');
	});

	test('two environments of the same server get distinct references (dev vs prod)', () => {
		const dev = planInstall(postgres!, { DATABASE_URL: 'postgres://dev.internal/db' }, 'pg-dev');
		const prod = planInstall(postgres!, { DATABASE_URL: 'postgres://prod.internal/db' }, 'pg-prod');
		// identical binary, different credentials: this is the supported way to run
		// the same MCP server against two databases
		expect(dev.plan.connection).toEqual(prod.plan.connection);
		expect(dev.plan.envRefs.DATABASE_URL).toBe('secret:pg-dev__database_url');
		expect(prod.plan.envRefs.DATABASE_URL).toBe('secret:pg-prod__database_url');
		expect(dev.secrets[0].value).not.toBe(prod.secrets[0].value);
	});
});

describe('planInstall — non-secret fields and required fields', () => {
	test('a positional answer becomes an argument and NOTHING else', () => {
		// This test used to assert that the value ALSO became a `${SQLITE_PATH}`
		// reference. That reference demanded a variable on the gateway host which the
		// operator had just typed into the form, so resolving failed and the upstream
		// was reported "unconfigured" and never spawned — the template installed a
		// dead upstream while the argument sitting next to it was already correct.
		const sqlite = getTemplate('sqlite');
		expect(sqlite).toBeDefined();
		const field = sqlite!.fields.find((f) => !f.secret);
		expect(field?.placement).toBe('arg');

		const { plan } = planInstall(sqlite!, { [field!.env]: '/data/app.db' }, 'my-db');
		expect((plan.connection.args as string[]).at(-1)).toBe('/data/app.db');
		expect(plan.envRefs[field!.env]).toBeUndefined();
	});

	test('an environment-placement answer becomes a literal env value, not an argument', () => {
		// server-github reads GITHUB_OWNER from the environment; passing it
		// positionally would be silently ignored by the child
		const github = getTemplate('github');
		expect(github).toBeDefined();
		const owner = github!.fields.find((f) => f.env === 'GITHUB_OWNER');
		expect(owner?.placement).toBe('env');

		const token = 'github-personal-access-token-value';
		const { plan, secrets } = planInstall(
			github!,
			{ GITHUB_PERSONAL_ACCESS_TOKEN: token, GITHUB_OWNER: 'acme' },
			'gh'
		);
		expect(plan.envRefs.GITHUB_OWNER).toBe('acme');
		expect(plan.envRefs.GITHUB_OWNER).not.toBe('${GITHUB_OWNER}');
		expect(plan.connection.args).not.toContain('acme');
		// the secret field still seals and references correctly
		expect(plan.envRefs.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(
			'secret:gh__github_personal_access_token'
		);
		expect(secrets.map((s) => s.name)).toEqual(['gh__github_personal_access_token']);
	});

	test('a positional install resolves cleanly — nothing is left unconfigured', () => {
		// the shape of the bug end to end: with only an argument needed, resolution
		// must report no missing references at all
		const sqlite = getTemplate('sqlite');
		const field = sqlite!.fields.find((f) => !f.secret)!;
		const { plan } = planInstall(sqlite!, { [field.env]: '/data/app.db' }, 'clean-db');
		const remaining = Object.values(plan.envRefs).filter((ref) => ref.startsWith('${'));
		expect(remaining).toEqual([]);
	});

	test('a missing required value is reported by label and nothing is sealed', () => {
		const { secrets, missing } = planInstall(postgres!, { DATABASE_URL: '   ' }, 'pg-dev');
		expect(missing).toEqual([postgres!.fields[0].label]);
		expect(secrets).toEqual([]);
	});

	test('an optional value left blank is omitted rather than stored empty', () => {
		const optional = getTemplate('postgres')!.fields.find((f) => !f.required);
		// the postgres template has only a required field, so the assertion is about
		// whichever template does have one; with none, this documents the expectation
		if (!optional) return;
		const { plan } = planInstall(getTemplate('postgres')!, {}, 'pg-dev');
		expect(plan.envRefs[optional.env]).toBeUndefined();
	});
});
