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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isRedirect } from '@sveltejs/kit';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import { actions } from '../../src/routes/admin/upstreams/new/+page.server';
import { ensureLoaded, getUpstreamBySlug } from '../../src/lib/server/registry';
import { openSecretByName, putSecret, secretExists } from '../../src/lib/server/governance/secrets';
import { resolveEnvRefs } from '../../src/lib/server/security/env-resolve';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { resetConfigCache } from '../../src/lib/server/config';
import { upstreamOauth } from '../../src/lib/server/db/schema';
import { getOAuthConfig } from '../../src/lib/server/upstream/oauth/store';
import { resolveAuthMode } from '../../src/lib/server/upstream/types';

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

/**
 * http:// to a private IP literal, exercised at the action itself.
 *
 * With MCPGW_ALLOW_PRIVATE_NETWORK=true, an http upstream pointing at a
 * private-range address registers like any other — the form's url check mirrors
 * the SSRF guard. Before the mirror landed, the form banned non-localhost
 * http:// outright (ActionFailure/400 + fieldErrors.url): the RED run pinned
 * exactly that ORDER observable, and then must fail, until the form mirrors the
 * guard.
 */
const PRIVATE_HTTP_FORM = {
	slug: 'mcp-priv',
	name: 'Private MCP',
	transport: 'http',
	url: 'http://10.99.0.102:3300/api/mcp',
	timeoutMs: '1000',
	env: ''
};

describe('the create action: http:// to a private IP literal with MCPGW_ALLOW_PRIVATE_NETWORK=true', () => {
	beforeAll(() => {
		process.env.MCPGW_ALLOW_PRIVATE_NETWORK = 'true';
		// the memoised config cache key tracks ONLY MCPGW_ENV_KEY (config.ts:374) —
		// setting the env var alone does NOT bust the cache
		resetConfigCache();
	});

	afterAll(() => {
		// restore, or test files sharing this bun process inherit the flag
		delete process.env.MCPGW_ALLOW_PRIVATE_NETWORK;
		resetConfigCache();
	});

	test('a private-range http upstream registers (303 + the row; the probe failed, healthy=0)', async () => {
		let result: unknown;
		let thrown: unknown;
		try {
			result = await callCreate(PRIVATE_HTTP_FORM);
		} catch (error) {
			// redirect() THROWS a Redirect (the action rethrows it): not an Error and
			// not an ActionFailure
			thrown = error;
		}

		if (!thrown) {
			// Only reachable while the form still bans non-localhost http:// (the
			// pre-mirror state): the action answered with an ActionFailure instead of
			// redirecting. Assert the ORDER facts, then fail so the run stays red
			// until the form's isHttpUrl mirrors the SSRF guard.
			const failure = result as { status: number; data: { fieldErrors?: Record<string, string> } };
			expect(failure.status).toBe(400);
			expect(failure.data.fieldErrors?.url).toContain('https://');
			expect(getUpstreamBySlug('mcp-priv')).toBeUndefined();
			throw new Error(
				`the form refused an http upstream to a private IP literal despite MCPGW_ALLOW_PRIVATE_NETWORK=true: ActionFailure/${failure.status} + "${failure.data.fieldErrors?.url}" + upstream-row=${getUpstreamBySlug('mcp-priv') === undefined ? 'absent' : 'present'}`
			);
		}

		expect(isRedirect(thrown)).toBe(true);
		const redirect = thrown as { status: number; location: string };
		expect(redirect.status).toBe(303);
		// the probe outcome is environment-dependent — on a managed private network
		// the private address actually serves the upstream (healthy=1, observed at
		// 760ms); where it is unreachable the record lands disabled (healthy=0,
		// pinned below). Only the created anchor is pinned for this URL.
		expect(redirect.location).toContain('created=1');

		// the row exists and stores the private http URL
		const row = getUpstreamBySlug('mcp-priv');
		expect(row).toBeDefined();
		expect(row?.transport).toBe('http');
		expect(row?.connection).toEqual({
			url: 'http://10.99.0.102:3300/api/mcp',
			authStyle: 'none'
		});
	});

	test('an UNREACHABLE private http upstream still registers, landing disabled with healthy=0', async () => {
		// TEST-NET-3 (RFC 5737) classifies 'private' for the guard and is guaranteed
		// never routable, so the probe deterministically fails in ~1s
		// (timeoutMs caps the handshake wrap) — unlike the live 10.99.0.102 above
		let thrown: unknown;
		try {
			await callCreate({
				...PRIVATE_HTTP_FORM,
				slug: 'mcp-priv-dead',
				name: 'Dead private MCP',
				url: 'http://203.0.113.5:3300/api/mcp'
			});
		} catch (error) {
			// redirect() THROWS a Redirect (the action rethrows it): not an Error and
			// not an ActionFailure
			thrown = error;
		}

		expect(isRedirect(thrown)).toBe(true);
		const redirect = thrown as { status: number; location: string };
		expect(redirect.status).toBe(303);
		// the probe failed, so the record is stored DISABLED with the error shown
		expect(redirect.location).toContain('healthy=0');
		const row = getUpstreamBySlug('mcp-priv-dead');
		expect(row).toBeDefined();
		expect(row?.enabled).toBe(false);
		expect(row?.connection).toEqual({
			url: 'http://203.0.113.5:3300/api/mcp',
			authStyle: 'none'
		});
	});
});

/**
 * OAuth creation contract (todo 11).
 *
 * The OAuth branch must never persist the static credential fields the same form
 * still submits, and the upstream plus its `upstream_oauth` row are one unit: a
 * failed OAuth insert rolls the upstream back instead of leaving a half-configured
 * record. The rendered form is compiled here directly so the exact redirect URI
 * and the auth-mode options are proven from the component output, not a substring
 * of its source.
 */
const REDIRECT_URI = 'https://gateway.example.test/oauth/callback';

async function createOutcome(form: Record<string, string>): Promise<{
	thrown?: unknown;
	result?: unknown;
}> {
	try {
		return { result: await callCreate(form) };
	} catch (error) {
		return { thrown: error };
	}
}

function expectRedirect(thrown: unknown): { status: number; location: string } {
	expect(isRedirect(thrown)).toBe(true);
	const redirect = thrown as { status: number; location: string };
	expect(redirect.status).toBe(303);
	return redirect;
}

function oauthRowCount(): number {
	return getDb().select().from(upstreamOauth).all().length;
}

describe('the create action: authMode oauth', () => {
	test('an OAuth HTTP create stores authMode oauth, no static refs, and a disconnected OAuth row with scopes', async () => {
		const { thrown } = await createOutcome({
			slug: 'dd-oauth',
			name: 'Datadog',
			transport: 'http',
			url: 'http://127.0.0.1:9/mcp',
			authMode: 'oauth',
			oauthScopes: '  mcp_all  ',
			authStyle: 'header',
			authName: 'x-api-key',
			authRef: 'secret:leftover-static',
			timeoutMs: '1000'
		});

		const redirect = expectRedirect(thrown);
		expect(redirect.location).toContain('/admin/upstreams/dd-oauth?created=1');

		const row = getUpstreamBySlug('dd-oauth');
		expect(row).toBeDefined();
		expect(row?.transport).toBe('http');
		expect(row?.connection).toEqual({
			url: 'http://127.0.0.1:9/mcp',
			authMode: 'oauth'
		});

		const oauth = getOAuthConfig(row!.id);
		expect(oauth?.status).toBe('disconnected');
		expect(oauth?.scopes).toBe('mcp_all');
		expect(oauth?.clientId ?? null).toBeNull();
		expect(oauth?.accessTokenRef ?? null).toBeNull();
		expect(oauth?.refreshTokenRef ?? null).toBeNull();
		expect(secretExists('leftover-static')).toBe(false);
	});

	test('an OAuth stdio create is a field error and writes neither an upstream nor an OAuth row', async () => {
		const before = oauthRowCount();
		const result = (await createOutcome({
			slug: 'dd-oauth-stdio',
			name: 'Datadog stdio',
			transport: 'stdio',
			command: process.execPath,
			args: FIXTURE,
			authMode: 'oauth',
			oauthScopes: 'mcp_all'
		})) as { result: { status: number; data: { fieldErrors?: Record<string, string> } } };

		expect(result.result.status).toBe(400);
		expect(result.result.data.fieldErrors?.transport).toBeTruthy();
		expect(getUpstreamBySlug('dd-oauth-stdio')).toBeUndefined();
		expect(oauthRowCount()).toBe(before);
	});

	test('a blank OAuth scope is a field error and writes nothing', async () => {
		const before = oauthRowCount();
		const result = (await createOutcome({
			slug: 'dd-oauth-blank',
			name: 'Datadog blank scope',
			transport: 'http',
			url: 'http://127.0.0.1:9/mcp',
			authMode: 'oauth',
			oauthScopes: '   '
		})) as { result: { status: number; data: { fieldErrors?: Record<string, string> } } };

		expect(result.result.status).toBe(400);
		expect(result.result.data.fieldErrors?.oauthScopes).toBeTruthy();
		expect(getUpstreamBySlug('dd-oauth-blank')).toBeUndefined();
		expect(oauthRowCount()).toBe(before);
	});

	test('an OAuth scope longer than 200 characters is a field error', async () => {
		const before = oauthRowCount();
		const result = (await createOutcome({
			slug: 'dd-oauth-long',
			name: 'Datadog long scope',
			transport: 'http',
			url: 'http://127.0.0.1:9/mcp',
			authMode: 'oauth',
			oauthScopes: 'x'.repeat(201)
		})) as { result: { status: number; data: { fieldErrors?: Record<string, string> } } };

		expect(result.result.status).toBe(400);
		expect(result.result.data.fieldErrors?.oauthScopes).toBeTruthy();
		expect(getUpstreamBySlug('dd-oauth-long')).toBeUndefined();
		expect(oauthRowCount()).toBe(before);
	});

	test('explicit static with a ref persists authMode static and the credential', async () => {
		putSecret('static-token', 'synthetic-static-token', { actorId: null, ip: null });
		const { thrown } = await createOutcome({
			slug: 'static-upstream',
			name: 'Static upstream',
			transport: 'http',
			url: 'http://127.0.0.1:9/mcp',
			authMode: 'static',
			authStyle: 'header',
			authName: 'x-api-key',
			authRef: 'secret:static-token',
			timeoutMs: '1000'
		});

		expectRedirect(thrown);
		const row = getUpstreamBySlug('static-upstream');
		expect(row?.connection).toEqual({
			url: 'http://127.0.0.1:9/mcp',
			authMode: 'static',
			authStyle: 'header',
			authName: 'x-api-key',
			authRef: 'secret:static-token'
		});
		expect(resolveAuthMode(row!.connection, row!.headersRef)).toBe('static');
		expect(getOAuthConfig(row!.id)).toBeUndefined();
	});

	test('explicit static without a ref is rejected by the registry matrix and writes nothing', async () => {
		const before = oauthRowCount();
		const result = (await createOutcome({
			slug: 'static-no-ref',
			name: 'Static without ref',
			transport: 'http',
			url: 'http://127.0.0.1:9/mcp',
			authMode: 'static',
			authStyle: 'bearer',
			timeoutMs: '1000'
		})) as { result: { status: number; data: { error?: string } } };

		expect(result.result.status).toBe(400);
		expect(result.result.data.error).toContain('credential reference');
		expect(getUpstreamBySlug('static-no-ref')).toBeUndefined();
		expect(oauthRowCount()).toBe(before);
	});

	test('explicit none ignores a submitted authRef and resolves to none', async () => {
		const { thrown } = await createOutcome({
			slug: 'none-with-ref',
			name: 'None with ref',
			transport: 'http',
			url: 'http://127.0.0.1:9/mcp',
			authMode: 'none',
			authStyle: 'header',
			authName: 'x-api-key',
			authRef: 'secret:ignored-static',
			timeoutMs: '1000'
		});

		expectRedirect(thrown);
		const row = getUpstreamBySlug('none-with-ref');
		expect(row?.connection).toEqual({
			url: 'http://127.0.0.1:9/mcp',
			authMode: 'none',
			authStyle: 'none'
		});
		expect(resolveAuthMode(row!.connection, row!.headersRef)).toBe('none');
		expect(secretExists('ignored-static')).toBe(false);
	});

	test('a legacy submission without authMode keeps the pre-change connection shape', async () => {
		putSecret('legacy-token', 'synthetic-legacy-token', { actorId: null, ip: null });
		const { thrown } = await createOutcome({
			slug: 'legacy-static',
			name: 'Legacy static',
			transport: 'http',
			url: 'http://127.0.0.1:9/mcp',
			authStyle: 'bearer',
			authRef: 'secret:legacy-token',
			timeoutMs: '1000'
		});

		expectRedirect(thrown);
		const row = getUpstreamBySlug('legacy-static');
		expect(row?.connection).toEqual({
			url: 'http://127.0.0.1:9/mcp',
			authStyle: 'bearer',
			authRef: 'secret:legacy-token'
		});
		expect((row?.connection as { authMode?: string }).authMode).toBeUndefined();
		expect(resolveAuthMode(row!.connection, row!.headersRef)).toBe('static');
	});
});

async function renderNewUpstreamForm(authMode: 'none' | 'static' | 'oauth'): Promise<string> {
	const dir = mkdtempSync(path.join(process.cwd(), '.render-new-upstream-'));
	try {
		const files: Record<string, string> = {
			'Button.svelte': path.join(process.cwd(), 'src/lib/ui/Button.svelte'),
			'Card.svelte': path.join(process.cwd(), 'src/lib/ui/Card.svelte'),
			'Page.svelte': path.join(process.cwd(), 'src/routes/admin/upstreams/new/+page.svelte')
		};

		const writeComponent = (name: string): void => {
			const filename = files[name]!;
			const source = readFileSync(filename, 'utf8');
			const { js } = compile(source, { generate: 'server', runes: true, filename });
			const code = js.code
				.replaceAll('$app/paths', './app-paths.js')
				.replaceAll('$app/forms', './app-forms.js')
				.replaceAll('$lib/ui/Button.svelte', './Button.js')
				.replaceAll('$lib/ui/Card.svelte', './Card.js');
			writeFileSync(path.join(dir, name.replace('.svelte', '.js')), code);
		};

		writeFileSync(path.join(dir, 'app-paths.js'), 'export const resolve = (path) => path;');
		writeFileSync(path.join(dir, 'app-forms.js'), 'export const enhance = () => {};');
		for (const name of Object.keys(files)) writeComponent(name);

		const page = await import(`${pathToFileURL(path.join(dir, 'Page.js')).href}?v=${Date.now()}`);
		const { body } = render(page.default, {
			props: {
				data: { secrets: [], templates: [], redirectUri: REDIRECT_URI },
				form: {
					values: { transport: 'http', authMode, oauthScopes: 'mcp_all' },
					fieldErrors: {}
				}
			}
		});
		return body;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('the new-upstream form render', () => {
	test('renders the exact OAuth redirect URI and the auth-mode options', async () => {
		const body = await renderNewUpstreamForm('oauth');

		expect(body).toContain(REDIRECT_URI);
		expect(body).toContain('name="authMode"');
		expect(body).toContain('value="none"');
		expect(body).toContain('value="static"');
		expect(body).toContain('value="oauth"');
		expect(body).toContain('Organization Settings');
		expect(body).toContain('MCP OAuth');
	});

	test('hides the static credential fields for none and oauth, and shows them for static', async () => {
		const none = await renderNewUpstreamForm('none');
		expect(none).not.toContain('name="authStyle"');
		expect(none).not.toContain('name="authName"');
		expect(none).not.toContain('name="authRef"');

		const oauth = await renderNewUpstreamForm('oauth');
		expect(oauth).not.toContain('name="authStyle"');
		expect(oauth).not.toContain('name="authName"');
		expect(oauth).not.toContain('name="authRef"');

		const staticMode = await renderNewUpstreamForm('static');
		expect(staticMode).toContain('name="authStyle"');
		expect(staticMode).toContain('name="authName"');
		expect(staticMode).toContain('name="authRef"');
	});
});
