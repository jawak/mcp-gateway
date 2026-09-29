/**
 * The "New secret" field on the upstream-creation form, exercised at the action
 * itself (no HTTP layer, no browser).
 *
 * The contract: a form whose env line references the secret typed into the SAME
 * form works in one submission — the action seals the secret BEFORE validating
 * env references against the vault. While the vault check runs first, every such
 * submission is refused with "does not exist — create it first" (an
 * ActionFailure/400) and leaves neither the secret nor the upstream behind: the
 * RED run below pins exactly that ORDER observable, and then must fail, until
 * the reorder puts `putSecret` in front.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isRedirect } from '@sveltejs/kit';
import { actions } from '../../src/routes/admin/upstreams/new/+page.server';
import { ensureLoaded, getUpstreamBySlug } from '../../src/lib/server/registry';
import { openSecretByName, secretExists } from '../../src/lib/server/governance/secrets';
import { resolveEnvRefs } from '../../src/lib/server/security/env-resolve';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { resetConfigCache } from '../../src/lib/server/config';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'echo-mcp-server.ts');

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-create-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '2'.repeat(64);
	// the memoised config survives across test files — a stale cache would poison
	// the master key and put the spawn's workdir at a stale data dir (the pool
	// reads getConfig() at construct)
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	ensureLoaded(getDb());
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	resetConfigCache();
});

/** Build the POST the form sends, and invoke the create action directly. */
async function callCreate(form: Record<string, string>): Promise<unknown> {
	const data = new FormData();
	for (const [key, value] of Object.entries(form)) data.append(key, value);
	const request = new Request('http://localhost/admin/upstreams/new?/create', {
		method: 'POST',
		body: data
	});
	return actions.create({
		request,
		locals: {},
		getClientAddress: () => '127.0.0.1'
	} as never);
}

const INLINE_SECRET_FORM = {
	slug: 'argo-plnm',
	name: 'Argo CD',
	transport: 'stdio',
	command: process.execPath,
	args: FIXTURE,
	env: 'ARGOCD_API_TOKEN=secret:argo-plnm__argo-plnm',
	secretName: 'argo-plnm__argo-plnm',
	secretValue: 'synthetic-token-0123456789'
};

describe('the create action: inline "New secret" ordering', () => {
	test('a form whose env line references the secret typed in the same form works in one submission', async () => {
		let result: unknown;
		let thrown: unknown;
		try {
			result = await callCreate(INLINE_SECRET_FORM);
		} catch (error) {
			// redirect() THROWS a Redirect (the action rethrows it): not an Error and
			// not an ActionFailure
			thrown = error;
		}

		if (!thrown) {
			// Only reachable while the vault check still runs BEFORE putSecret (the
			// pre-fix order): the action answered with an ActionFailure instead of
			// redirecting. Assert the four ORDER facts, then fail so the run stays
			// red until the reorder lands.
			const failure = result as { status: number; data: { fieldErrors?: Record<string, string> } };
			expect(failure.status).toBe(400);
			expect(failure.data.fieldErrors?.env).toContain('does not exist');
			expect(secretExists('argo-plnm__argo-plnm')).toBe(false);
			expect(getUpstreamBySlug('argo-plnm')).toBeUndefined();
			throw new Error(
				`the form refused a submission whose "New secret" it was given — ORDER bug (putSecret runs AFTER the vault check): ActionFailure/${failure.status} + "${failure.data.fieldErrors?.env}" + secretExists=${secretExists('argo-plnm__argo-plnm')} + upstream-row=${getUpstreamBySlug('argo-plnm') === undefined ? 'absent' : 'present'}`
			);
		}

		expect(isRedirect(thrown)).toBe(true);
		const redirect = thrown as { status: number; location: string };
		expect(redirect.status).toBe(303);
		expect(redirect.location).toBe('/admin/upstreams/argo-plnm?created=1&healthy=1');

		// the row stores the reference, the vault holds the sealed value
		expect(getUpstreamBySlug('argo-plnm')?.envRefs).toEqual({
			ARGOCD_API_TOKEN: 'secret:argo-plnm__argo-plnm'
		});
		expect(secretExists('argo-plnm__argo-plnm')).toBe(true);

		// and the sealed value round-trips into the child environment
		const resolved = resolveEnvRefs(getUpstreamBySlug('argo-plnm')!.envRefs, {
			openSecret: openSecretByName
		});
		expect(resolved.missing).toEqual([]);
		expect(resolved.values.ARGOCD_API_TOKEN).toBe('synthetic-token-0123456789');
	});

	test('regression guard: env → a missing secret with NO inline field still fails 400 and leaves nothing behind', async () => {
		const result = (await callCreate({
			slug: 'argo-plnm-bare',
			name: 'Argo CD bare',
			transport: 'stdio',
			command: process.execPath,
			args: FIXTURE,
			env: 'ARGOCD_API_TOKEN=secret:argo-plnm-missing'
		})) as { status: number; data: { fieldErrors?: Record<string, string> } };

		expect(result.status).toBe(400);
		expect(result.data.fieldErrors?.env).toContain('does not exist');
		// unchanged behavior: no row, no secret
		expect(getUpstreamBySlug('argo-plnm-bare')).toBeUndefined();
		expect(secretExists('argo-plnm-missing')).toBe(false);
	});

	test('a missing OTHER reference still fails 400 — the inline secret stays sealed (orphan secret)', async () => {
		const result = (await callCreate({
			slug: 'argo-plnm2',
			name: 'Argo CD second',
			transport: 'stdio',
			command: process.execPath,
			args: FIXTURE,
			env: 'ARGOCD_API_TOKEN=secret:argo-plnm2__token\nOTHER=secret:other-missing',
			secretName: 'argo-plnm2__token',
			secretValue: 'synthetic-token-0123456789'
		})) as { status: number; data: { fieldErrors?: Record<string, string> } };

		// the failure names the OTHER ref, and the new secret was still sealed
		expect(result.status).toBe(400);
		expect(result.data.fieldErrors?.env).toContain('does not exist');
		expect(result.data.fieldErrors?.env).toContain('other-missing');
		expect(secretExists('argo-plnm2__token')).toBe(true);
		expect(openSecretByName('argo-plnm2__token')).toBe('synthetic-token-0123456789');
		// no upstream row: the submission failed
		expect(getUpstreamBySlug('argo-plnm2')).toBeUndefined();
	});
});
