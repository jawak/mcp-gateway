/**
 * Installing the same MCP server twice — the "dev and prod PostgreSQL" question.
 *
 * The unit tests prove the plan is shaped correctly; this proves the chain an
 * operator actually walks: template answers → sealed secret → stored upstream →
 * resolved child environment, plus the isolation that makes two environments safe
 * to run side by side. No database is contacted; resolution is checked with the same
 * helper the stdio transport uses at spawn time.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getTemplate, planInstall } from '../../src/lib/server/templates';
import { openSecretByName } from '../../src/lib/server/upstream/stdio';
import { resolveEnvRefs } from '../../src/lib/server/security/env-resolve';
import {
	createProfile,
	createUpstream,
	ensureLoaded,
	getUpstreamBySlug,
	scopeForProfile
} from '../../src/lib/server/registry';
import { putSecret } from '../../src/lib/server/governance/secrets';
import { renderManifest } from '../../src/lib/server/registry/manifest';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-tpl-'));
const DEV_URL = 'postgres://dev_role:dev-pass@dev.internal:5432/app';
const PROD_URL = 'postgres://prod_role:prod-pass@prod.internal:5432/app';

const actor = { actorId: null, ip: '127.0.0.1' };

/** What the install route does, in order. */
function installFromTemplate(templateId: string, slug: string, answers: Record<string, string>) {
	const template = getTemplate(templateId);
	if (!template) throw new Error(`no template ${templateId}`);
	const { plan, secrets, missing } = planInstall(template, answers, slug);
	if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}`);
	for (const secret of secrets) putSecret(secret.name, secret.value, actor);
	return createUpstream(
		{
			slug: plan.slug,
			name: plan.name,
			transport: plan.transport,
			connection: plan.connection as never,
			envRefs: plan.envRefs,
			pin: 'pinned',
			enabled: true
		},
		actor
	);
}

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '2'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	ensureLoaded(getDb());
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('two Postgres upstreams from one template', () => {
	test('both install, same command, distinct credentials', () => {
		const dev = installFromTemplate('postgres', 'pg-dev', { DATABASE_URL: DEV_URL });
		const prod = installFromTemplate('postgres', 'pg-prod', { DATABASE_URL: PROD_URL });

		expect(dev.connection).toEqual(prod.connection);
		expect(getUpstreamBySlug('pg-dev')?.envRefs).toEqual({
			DATABASE_URL: 'secret:pg-dev__database_url'
		});
		expect(getUpstreamBySlug('pg-prod')?.envRefs).toEqual({
			DATABASE_URL: 'secret:pg-prod__database_url'
		});
	});

	test('each spawns with its OWN connection string, resolved at spawn time', () => {
		// this is the assertion that would have caught the bug: before the fix the
		// reference was a literal, so the child received the secret's *name*
		const dev = resolveEnvRefs(getUpstreamBySlug('pg-dev')!.envRefs, {
			openSecret: openSecretByName
		});
		const prod = resolveEnvRefs(getUpstreamBySlug('pg-prod')!.envRefs, {
			openSecret: openSecretByName
		});

		expect(dev.missing).toEqual([]);
		expect(prod.missing).toEqual([]);
		expect(dev.values.DATABASE_URL).toBe(DEV_URL);
		expect(prod.values.DATABASE_URL).toBe(PROD_URL);
		expect(dev.values.DATABASE_URL).not.toContain('pg-dev__database_url');
	});

	test('the plaintext never reaches the database, and the manifest export stays clean (BR-09)', () => {
		const raw = JSON.stringify(
			['pg-dev', 'pg-prod'].map((slug) => getUpstreamBySlug(slug)?.envRefs ?? {})
		);
		expect(raw).not.toContain('dev-pass');
		expect(raw).not.toContain('prod-pass');

		const manifest = renderManifest();
		expect(manifest).toContain('secret:pg-dev__database_url');
		expect(manifest).toContain('secret:pg-prod__database_url');
		expect(manifest).not.toContain('dev-pass');
		expect(manifest).not.toContain('prod-pass');
	});

	test('a dev-only profile cannot see or name a prod tool', () => {
		const devProfile = createProfile({
			name: 'dev-only',
			links: [{ upstreamId: getUpstreamBySlug('pg-dev')!.id, allowGlobs: ['*'] }]
		});
		const scope = scopeForProfile(devProfile.id);
		expect(scope.map((entry) => entry.upstream.slug)).toEqual(['pg-dev']);
		// qualified names are how clients address tools, so a guessed prod name is not
		// merely hidden — it is outside this profile's scope entirely
		expect(scope.some((entry) => entry.upstream.slug === 'pg-prod')).toBe(false);
	});
});

describe('a positional template installs a spawn-ready upstream', () => {
	test('sqlite: the answer goes to argv and resolution reports nothing missing', () => {
		const created = installFromTemplate('sqlite', 'lite-e2e', { SQLITE_PATH: '/srv/app.db' });
		expect((created.connection as { args: string[] }).args.at(-1)).toBe('/srv/app.db');

		const record = getUpstreamBySlug('lite-e2e')!;
		const resolved = resolveEnvRefs(record.envRefs, { openSecret: openSecretByName });
		// before the fix this reported [{env:'SQLITE_PATH', reason:'no-such-env'}],
		// which made connectStdio throw UnconfiguredUpstreamError forever
		expect(resolved.missing).toEqual([]);
		expect(resolved.values).toEqual({});
	});

	test('filesystem: same, with the directory as a positional argument', () => {
		installFromTemplate('filesystem', 'files-e2e', { ALLOWED_DIR: '/srv/data' });
		const record = getUpstreamBySlug('files-e2e')!;
		const resolved = resolveEnvRefs(record.envRefs, { openSecret: openSecretByName });
		expect(resolved.missing).toEqual([]);
		expect((record.connection as { args: string[] }).args.at(-1)).toBe('/srv/data');
	});
});
