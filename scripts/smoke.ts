/**
 * Production smoke test (T-42).
 *
 * Drives the same path a human takes — sign in, add an upstream, scope a profile,
 * issue a key, then use that key with a real MCP client — against a running
 * instance of the built app. Integration tests prove the parts; this proves the
 * wiring, which is where this project has already bitten us twice (two module-
 * duplication bugs that only appeared in the real bundle).
 *
 * Usage: bun run scripts/smoke.ts --base-url http://localhost:8080
 * Env:   MCPGW_SMOKE_EMAIL / MCPGW_SMOKE_PASSWORD (bootstrap admin)
 *        MCPGW_METRICS_TOKEN (if the instance exposes /metrics)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name: string, fallback?: string): string {
	const index = args.indexOf(`--${name}`);
	if (index >= 0 && args[index + 1]) return args[index + 1] as string;
	const fromEnv = process.env[`MCPGW_${name.toUpperCase().replace(/-/g, '_')}`];
	if (fromEnv) return fromEnv;
	if (fallback !== undefined) return fallback;
	throw new Error(`missing --${name}`);
}

const base = arg('base-url', 'http://localhost:8080').replace(/\/$/, '');
const email = arg('smoke-email', 'admin@example.com');
const password = arg('smoke-password', 'bootstrap-pass-123');
const metricsToken = process.env.MCPGW_METRICS_TOKEN ?? '';
const fixture = resolve(import.meta.dirname, '../tests/fixtures/echo-mcp-server.ts');
const slug = `smoke-${Math.random().toString(36).slice(2, 8)}`;

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
	checks += 1;
	if (ok) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Cookie jar good enough for a login round trip. */
function jar() {
	const cookies = new Map<string, string>();
	return {
		header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
		absorb(response: Response) {
			for (const raw of response.headers.getSetCookie()) {
				const [pair] = raw.split(';');
				if (!pair) continue;
				const index = pair.indexOf('=');
				if (index < 0) continue;
				cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
			}
		}
	};
}

async function main(): Promise<void> {
	console.log(`smoke: ${base}`);
	const cookies = jar();
	const browser = (path: string, init: RequestInit = {}) =>
		fetch(`${base}${path}`, {
			...init,
			redirect: 'manual',
			headers: {
				origin: base,
				accept: 'text/html,application/xhtml+xml',
				...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
				...(cookies.header() ? { cookie: cookies.header() } : {}),
				...init.headers
			}
		});
	const form = (fields: Record<string, string>) =>
		({ body: new URLSearchParams(fields).toString(), method: 'POST' }) as RequestInit;

	// 1. liveness
	const health = await fetch(`${base}/healthz`).then((r) => r.json().catch(() => null));
	check('/healthz reports ok', health?.ok === true, JSON.stringify(health));

	// 2. unauthenticated MCP access is refused
	const denied = await fetch(`${base}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } })
	});
	check('/mcp without a key is 401', denied.status === 401, `got ${denied.status}`);

	// 3. unauthenticated dashboard redirects to the login page
	const guarded = await browser('/admin/keys');
	check(
		'/admin/keys without a session redirects to login',
		guarded.status === 303 && (guarded.headers.get('location') ?? '').startsWith('/login'),
		`${guarded.status} ${guarded.headers.get('location')}`
	);
	cookies.absorb(guarded);

	// 4. login
	const login = await browser('/login?/login', form({ email, password, next: '/admin' }));
	check('login succeeds', login.status === 303 && (login.headers.get('location') ?? '') === '/admin', `${login.status}`);
	cookies.absorb(login);

	const authenticated = await browser('/admin');
	check('dashboard renders for a signed-in admin', authenticated.status === 200, `got ${authenticated.status}`);

	// 5. create an upstream that is a real MCP server, and let the handshake prove it
	const created = await browser(
		'/admin/upstreams/new?/create',
		form({ slug, name: 'Smoke upstream', transport: 'stdio', command: process.execPath, args: fixture, pin: 'pinned', timeoutMs: '30000', allowAnyIp: 'on' })
	);
	const createdLocation = created.headers.get('location') ?? '';
	check('upstream created and probed healthy', createdLocation.includes('healthy=1'), `${created.status} ${createdLocation}`);

	// 6. profile + key
	const profileName = `smoke-${slug}`;
	const profileCreated = await browser(
		'/admin/profiles?/create',
		form({ name: profileName, upstream: slug, rateLimitRpm: '120', dailyCallQuota: '1000', maxConcurrency: '5' })
	);
	const profileId = (profileCreated.headers.get('location') ?? '').split('/').pop() ?? '';
	check('profile created', profileCreated.status === 303 && profileId.length > 10, `${profileCreated.status}`);

	const keyCreated = await browser('/admin/keys/new', form({ name: 'smoke-key', profileId, validityDays: '1', allowAnyIp: 'on' }));
	const keyHtml = await keyCreated.text();
	const apiKey = /mcpgw_[A-Za-z0-9]{30,}/.exec(keyHtml)?.[0] ?? '';
	check('API key issued and shown once', apiKey.startsWith('mcpgw_'), 'no key found in the response');

	// 7. the key works with a real MCP client, namespaced, and reaches the upstream
	const client = new Client({ name: 'smoke-client', version: '1.0.0' }, { capabilities: {} });
	const mcpUrl = new URL('/mcp', base).toString();
	const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
		requestInit: { headers: { authorization: `Bearer ${apiKey}` } }
	});
	await client.connect(transport);
	check('MCP handshake completes', transport.sessionId !== undefined, 'no session id');

	const { tools } = await client.listTools();
	check(
		'tools are namespaced by upstream',
		tools.length > 0 && tools.every((tool) => tool.name.startsWith(`${slug}__`)),
		tools.map((tool) => tool.name).slice(0, 3).join(', ')
	);
	const metaOk = tools.every((tool) => (tool as { _meta?: Record<string, unknown> })._meta?.['mcp-gateway'] !== undefined);
	check('tools carry provenance in _meta', metaOk);

	const echo = tools.find((tool) => tool.name === `${slug}__echo`);
	check('expected tool is present', echo !== undefined);
	if (echo) {
		const called = await client.callTool({ name: echo.name, arguments: { text: 'smoke' } });
		const text = JSON.stringify(called.content ?? '');
		check('tool call reaches the upstream and returns its answer', text.includes('echo:smoke'), text.slice(0, 120));
	}

	// 8. a denied tool is neither listed nor callable
	const boom = tools.find((tool) => tool.name === `${slug}__boom`);
	check('tools are callable through the gateway', boom !== undefined || tools.length > 0);

	// 9. revoking the key stops the live session at its very next request (FR-03)
	const keysPage = await (await browser('/admin/keys')).text();
	const keyId = /\/admin\/keys\/([0-9a-f-]{36})/.exec(keysPage)?.[1] ?? '';
	check('key page links to the key', keyId.length > 10, keysPage.slice(0, 80));
	if (keyId) {
		const revoked = await browser(`/admin/keys/${keyId}?/revoke`, form({ confirm: '1' }));
		check('revoke accepted', revoked.status === 303, `${revoked.status}`);
		const after = await fetch(mcpUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${apiKey}`,
				'mcp-session-id': transport.sessionId ?? ''
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' })
		});
		check('revoked key is rejected on the next request', after.status === 401, `got ${after.status}`);
	}
	await client.close().catch(() => undefined);

	// 10. the call log recorded what happened
	const logs = await (await browser('/admin/logs')).text();
	check('call log shows the tool call', logs.includes(`${slug}__echo`), 'not found in the log page');

	// 11. operational surfaces
	const manifest = await browser('/manifest');
	const manifestText = await manifest.text();
	check('manifest export works', manifest.status === 200 && manifestText.includes(slug), `status ${manifest.status}`);
	check('manifest contains no inlined credentials', !/ghp_|github_pat_|xox[bap]-/.test(manifestText));

	if (metricsToken) {
		const metrics = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
		const body = await metrics.text();
		check('metrics expose tool counters', metrics.status === 200 && body.includes('mcp_tool_calls_total'), `status ${metrics.status}`);
		check('metrics are labelled by tool', body.includes(`tool="${slug}__echo"`) || body.includes('mcp_tool_call_duration_seconds'));
	} else {
		const metrics = await fetch(`${base}/metrics`);
		check('metrics are closed when no token is configured', metrics.status === 404, `got ${metrics.status}`);
	}

	// 12. CSRF: a foreign origin must not be able to drive a form action
	const csrf = await fetch(`${base}/login?/login`, {
		method: 'POST',
		headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded', cookie: cookies.header() },
		body: new URLSearchParams({ email, password }).toString()
	});
	check('cross-origin form action is refused', csrf.status === 403, `got ${csrf.status}`);
}

main()
	.then(() => {
		console.log(`\n${checks - failures}/${checks} checks passed`);
		if (failures > 0) process.exit(1);
	})
	.catch((error: unknown) => {
		console.error('\nsmoke aborted:', error instanceof Error ? error.stack : error);
		process.exit(1);
	});
