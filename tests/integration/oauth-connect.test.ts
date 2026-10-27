/**
 * OAuth connect — intended end-to-end flow.
 *
 * This is the TDD red test for the generic `authMode: 'oauth'` upstream path.
 * The fixture half already works (discovery, DCR, authorize, PKCE exchange,
 * tools/list); the gateway half stays red until the OAuth provider/store and
 * `connectRemoteHttp` wiring land. It must fail with a clear assertion that
 * OAuth is not implemented, never with a module/import error.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { connectRemoteHttp } from '../../src/lib/server/upstream/remote-http';
import {
	UnconfiguredUpstreamError,
	type UpstreamRecord
} from '../../src/lib/server/upstream/types';
import { uuidv7 } from '../../src/lib/shared/ids';
import { startOAuthFixture, type OAuthFixture } from '../fixtures/oauth-server';

const REDIRECT_URI = 'http://127.0.0.1:49152/oauth/callback';
const RED_PREFIX = 'OAuth is not implemented';

let dir: string;
let fixture: OAuthFixture;

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = 'e'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	fixture = await startOAuthFixture();
});

afterAll(() => {
	fixture?.stop();
	rmSync(dir, { recursive: true, force: true });
});

function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

/** Fixture-side flow: discovery → DCR → authorize → callback exchange → tools/list. */
async function runFixtureConnectFlow(): Promise<string[]> {
	const discovery = await fetch(`${fixture.origin}/.well-known/oauth-protected-resource`);
	expect(discovery.status).toBe(200);
	const resource = (await discovery.json()) as { authorization_servers?: string[] };
	expect(resource.authorization_servers).toEqual([`${fixture.origin}/v1/mcp`]);

	const registration = await fetch(`${fixture.origin}/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			client_name: 'mcp-gateway (oauth-connect-test)',
			redirect_uris: [REDIRECT_URI],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none'
		})
	});
	expect(registration.status).toBe(201);
	const { client_id: clientId } = (await registration.json()) as { client_id: string };

	const { verifier, challenge } = pkcePair();
	const state = randomBytes(16).toString('base64url');
	const authorizeUrl = new URL(`${fixture.origin}/authorize`);
	authorizeUrl.searchParams.set('response_type', 'code');
	authorizeUrl.searchParams.set('client_id', clientId);
	authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
	authorizeUrl.searchParams.set('state', state);
	authorizeUrl.searchParams.set('code_challenge', challenge);
	authorizeUrl.searchParams.set('code_challenge_method', 'S256');
	authorizeUrl.searchParams.set('scope', 'mcp_all');
	const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
	expect(authorize.status).toBe(302);
	const callback = new URL(authorize.headers.get('location') as string);
	expect(callback.searchParams.get('state')).toBe(state);

	// What the gateway's /oauth/callback route will do: exchange code + verifier.
	const tokenResponse = await fetch(`${fixture.origin}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: clientId,
			code: callback.searchParams.get('code') as string,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier
		})
	});
	expect(tokenResponse.status).toBe(200);
	const tokens = (await tokenResponse.json()) as { access_token: string };

	const client = new Client({ name: 'oauth-connect-test', version: '1.0.0' }, { capabilities: {} });
	const transport = new StreamableHTTPClientTransport(new URL(fixture.mcpUrl), {
		requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } }
	});
	try {
		await client.connect(transport);
		const { tools } = await client.listTools();
		return tools.map((tool) => tool.name);
	} finally {
		await client.close().catch(() => undefined);
	}
}

type GatewayProbe = { ok: true } | { ok: false; reason: string };

/**
 * The product half: `authMode: 'oauth'` must be a first-class connection mode,
 * and an unauthorized OAuth upstream must surface `authorization_required`
 * without attempting a static-auth request to the resource server.
 */
async function probeGatewayOAuthSupport(): Promise<GatewayProbe> {
	const typesModule = (await import('../../src/lib/server/upstream/types')) as Record<
		string,
		unknown
	>;
	const resolveAuthMode = typesModule.resolveAuthMode;
	if (typeof resolveAuthMode !== 'function') {
		return {
			ok: false,
			reason:
				'src/lib/server/upstream/types.ts exports no `resolveAuthMode` (todo 2) and there is no OAuth provider/store (todos 4-8); `authMode: "oauth"` is not a supported connection mode, so `connectRemoteHttp` falls back to static headers and the fixture rejects the request with 401.'
		};
	}

	const mode = (resolveAuthMode as (connection: unknown, headersRef?: string | null) => string)(
		{ url: fixture.mcpUrl, authMode: 'oauth' },
		null
	);
	if (mode !== 'oauth') {
		return { ok: false, reason: `resolveAuthMode returned "${mode}" for authMode "oauth"` };
	}

	const record: UpstreamRecord = {
		id: uuidv7(),
		slug: 'oauth-fixture',
		name: 'OAuth fixture upstream',
		transport: 'http',
		enabled: true,
		connection: {
			url: fixture.mcpUrl,
			authMode: 'oauth'
		} as unknown as UpstreamRecord['connection'],
		envRefs: {},
		timeoutMs: 5_000,
		pin: 'pinned'
	};

	const requestsBefore = fixture.requests.mcp;
	let error: unknown;
	try {
		const handle = await connectRemoteHttp({ record });
		await handle.close();
	} catch (cause) {
		error = cause;
	}
	if (fixture.requests.mcp !== requestsBefore) {
		return {
			ok: false,
			reason: 'an unauthorized OAuth upstream opened an MCP request instead of failing closed'
		};
	}
	if (!(error instanceof UnconfiguredUpstreamError)) {
		return {
			ok: false,
			reason: `expected UnconfiguredUpstreamError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
		};
	}
	if (!/authorization required/i.test(error.message)) {
		return {
			ok: false,
			reason: `UnconfiguredUpstreamError did not name the authorization requirement: ${error.message}`
		};
	}
	return { ok: true };
}

test('oauth connect: start -> authorize -> callback -> listTools', async () => {
	const tools = await runFixtureConnectFlow();
	expect(tools).toContain('echo');

	const gateway = await probeGatewayOAuthSupport();
	expect(gateway.ok, `${RED_PREFIX}: ${gateway.ok ? '' : gateway.reason}`).toBe(true);
});
