/**
 * Manifest import/export tests (T-20): round-trip fidelity, idempotence, secret
 * rejection, and the removal-disables-not-deletes rule.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import {
	manifestSchema,
	applyManifest,
	diffManifest,
	findInlinedSecrets,
	isReference,
	parseManifest,
	renderManifest,
	ManifestError
} from '../../src/lib/server/registry/manifest';
import { getSnapshot, listProfiles, listUpstreams, reload } from '../../src/lib/server/registry';
import { upstreams } from '../../src/lib/server/db/schema';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { uuidv7 } from '../../src/lib/shared/ids';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-manifest-'));

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = 'e'.repeat(64);
	process.env.SENTRY_TOKEN = 'set-on-host';
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

/** Parse without the secret guard, so the guard itself can be unit-tested. */
function manifestSchemaSafe(text: string) {
	// deliberately bypass the guard: feed the schema output straight through
	return manifestSchema.parse(yaml.parse(text));
}
const SAMPLE = `
version: 1
upstreams:
  - slug: github
    name: GitHub
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: \${GITHUB_TOKEN}
    pin: pinned
  - slug: sentry
    name: Sentry
    transport: http
    url: https://mcp.sentry.dev/mcp
    authStyle: bearer
    authRef: secret:sentry-token
    env:
      SENTRY_TOKEN: \${SENTRY_TOKEN}
profiles:
  - name: default
    rateLimitRpm: 90
    dailyCallQuota: 500
    maxConcurrency: 5
    upstreams:
      - slug: github
      - slug: sentry
        deny: ['*delete*']
`;

describe('parsing', () => {
	test('accepts a valid manifest and normalises defaults', () => {
		const manifest = parseManifest(SAMPLE);
		expect(manifest.version).toBe(1);
		expect(manifest.upstreams.map((upstream) => upstream.slug)).toEqual(['github', 'sentry']);
		expect(manifest.upstreams[1]?.authRef).toBe('secret:sentry-token');
	});

	test('rejects malformed YAML with a readable message', () => {
		expect(() => parseManifest('version: 1\nupstreams: [oops')).toThrow(ManifestError);
	});

	test('rejects schema violations naming the path', () => {
		expect(() => parseManifest('version: 1\nupstreams:\n  - slug: X\n')).toThrow(
			/upstreams\.0\.slug/
		);
	});

	test('rejects a stdio upstream without a command and an http one without a url', () => {
		expect(() =>
			parseManifest('version: 1\nupstreams:\n  - {slug: nocmd, name: n, transport: stdio}\n')
		).toThrow(/needs a command/);
		expect(() =>
			parseManifest('version: 1\nupstreams:\n  - {slug: nourl, name: n, transport: http}\n')
		).toThrow(/needs a url/);
	});

	test('rejects duplicate slugs and dangling profile references', () => {
		expect(() =>
			parseManifest(
				'version: 1\nupstreams:\n  - {slug: dup, name: a, transport: stdio, command: x}\n  - {slug: dup, name: b, transport: stdio, command: y}\n'
			)
		).toThrow(/duplicate slugs/);
		expect(() =>
			parseManifest('version: 1\nprofiles:\n  - name: p\n    upstreams:\n      - slug: ghost\n')
		).toThrow(/unknown upstream "ghost"/);
	});
});

describe('secret guarding (BR-09)', () => {
	test('recognises reference forms', () => {
		expect(isReference('${GITHUB_TOKEN}')).toBe(true);
		expect(isReference('secret:sentry-token')).toBe(true);
		expect(isReference('ghp_realvalue000000000000')).toBe(false);
		expect(isReference('plain-value')).toBe(false);
	});

	test('refuses an inlined credential and names the field', () => {
		const inline =
			'version: 1\nupstreams:\n  - {slug: leaky, name: L, transport: stdio, command: x, env: {GH_TOKEN: ghp_A1b2C3d4E5f6G7h8I9j0}}\n';
		// the guard runs during parse, so there is no way to get a parsed-but-unsafe
		// manifest into applyManifest by accident
		expect(() => parseManifest(inline)).toThrow(/env GH_TOKEN looks like a real credential/);
		// the detector itself is also callable for linting a file before import
		const unsafe = manifestSchemaSafe(inline);
		expect(findInlinedSecrets(unsafe).join(' ')).toContain('env GH_TOKEN');
	});

	test('import rejects the file entirely, writing nothing', () => {
		const before = listUpstreams().length;
		expect(() =>
			applyManifest(
				parseManifest(
					'version: 1\nupstreams:\n  - {slug: sneaky, name: S, transport: stdio, command: x, env: {T: ghp_A1b2C3d4E5f6G7h8I9j0}}\n'
				)
			)
		).toThrow(/real credential/);
		// parseManifest already rejected it, so the store is untouched
		expect(listUpstreams().length).toBe(before);
	});
});

describe('apply', () => {
	test('creates upstreams and profiles from the manifest', () => {
		const manifest = parseManifest(SAMPLE);
		const result = applyManifest(manifest);
		expect(result.added.sort()).toEqual(['github', 'sentry']);
		const stored = listUpstreams()
			.map((record) => record.slug)
			.sort();
		expect(stored).toEqual(['github', 'sentry']);
		expect(getSnapshot().upstreamsBySlug.get('sentry')?.timeoutMs).toBe(60_000);
		expect(getSnapshot().upstreamsBySlug.get('github')?.envRefs).toEqual({
			GITHUB_TOKEN: '${GITHUB_TOKEN}'
		});
		expect(listProfiles().map((profile) => profile.name)).toEqual(['default']);
		expect(getSnapshot().profilesById.get(listProfiles()[0]!.id)?.rateLimitRpm).toBe(90);
		const links = getSnapshot().profilesById.get(listProfiles()[0]!.id)!.links;
		expect(links.find((link) => link.upstream.slug === 'sentry')?.denyGlobs).toEqual(['*delete*']);
	});

	test('re-applying the same file writes nothing (idempotent)', () => {
		const manifest = parseManifest(SAMPLE);
		const diff = diffManifest(manifest);
		expect(diff.added).toEqual([]);
		expect(diff.updated).toEqual([]);
		expect(diff.removed).toEqual([]);
		expect(diff.unchanged.sort()).toEqual(['github', 'sentry']);
		const result = applyManifest(manifest);
		expect(result.unchanged.length).toBe(2);
	});

	test('a changed limit is reported as an update to the profile', () => {
		const modified = parseManifest(SAMPLE.replace('rateLimitRpm: 90', 'rateLimitRpm: 42'));
		const result = applyManifest(modified);
		expect(result.updated).toEqual([]); // upstreams themselves are unchanged
		expect(result.profilesUpdated).toEqual(['default']);
		expect(getSnapshot().profilesById.get(listProfiles()[0]!.id)?.rateLimitRpm).toBe(42);
	});

	test('an upstream missing from the file is disabled, never deleted', () => {
		const full = parseManifest(SAMPLE);
		const withoutSentry = {
			...full,
			upstreams: full.upstreams.filter((upstream) => upstream.slug !== 'sentry'),
			profiles: full.profiles.map((profile) => ({
				...profile,
				upstreams: profile.upstreams.filter((link) => link.slug !== 'sentry')
			}))
		};
		const result = applyManifest(withoutSentry);
		expect(result.removed).toEqual(['sentry']);
		// the row survives, so re-adding it later restores the previous configuration
		expect(listUpstreams().some((record) => record.slug === 'sentry')).toBe(true);
		expect(getSnapshot().upstreamsBySlug.get('sentry')?.enabled).toBe(false);

		// putting it back re-enables it without losing anything
		const restored = applyManifest(full);
		expect(restored.added).toEqual([]);
		expect(getSnapshot().upstreamsBySlug.get('sentry')?.enabled).toBe(true);
	});

	test('an upstream whose env reference is unset is reported as unconfigured', () => {
		const manifest = parseManifest(
			'version: 1\nupstreams:\n  - {slug: needsenv, name: N, transport: stdio, command: x, env: {MISSING_VAR: "${MISSING_VAR}"}}\n'
		);
		const result = applyManifest(manifest);
		expect(result.unconfigured.find((entry) => entry.slug === 'needsenv')?.missing).toEqual([
			'MISSING_VAR'
		]);
		// and one whose host env IS set is not
		const ok = parseManifest(
			'version: 1\nupstreams:\n  - {slug: hasenv, name: H, transport: stdio, command: x, env: {SENTRY_TOKEN: "${SENTRY_TOKEN}"}}\n'
		);
		expect(applyManifest(ok).unconfigured.map((entry) => entry.slug)).not.toContain('hasenv');
	});
});

describe('export', () => {
	test('round-trips: export → parse → no diff', () => {
		const text = renderManifest();
		const parsed = parseManifest(text);
		expect(diffManifest(parsed).updated).toEqual([]);
		expect(diffManifest(parsed).added).toEqual([]);
		expect(diffManifest(parsed).removed).toEqual([]);
	});

	test('never emits a secret value, only references', () => {
		getDb()
			.insert(upstreams)
			.values({
				id: uuidv7(),
				slug: 'withsecret',
				name: 'With secret',
				transport: 'stdio',
				connection: { command: 'x', authRef: 'secret:api-token' },
				envRefs: { API_TOKEN: 'secret:api-token' }
			})
			.run();
		reload(getDb());
		const text = renderManifest();
		expect(text).toContain('secret:api-token');
		expect(text).toContain('${');
		// nothing that looks like a literal token sneaks into the export
		expect(findInlinedSecrets(parseManifest(text))).toEqual([]);
	});
});

describe('cleanup', () => {
	test('fixture directory is removed', () => {
		rmSync(dir, { recursive: true, force: true });
	});
});
