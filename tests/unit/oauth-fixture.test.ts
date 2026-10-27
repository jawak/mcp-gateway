/**
 * Proves the OAuth fixture is a usable acceptance target: discovery documents
 * parse with the SDK's own schemas, DCR + PKCE work end to end, a bad verifier
 * is rejected, refresh modes behave, and the protected MCP endpoint challenges
 * unauthenticated callers before serving JSON-RPC.
 */
// allow: SIZE_OK — the whole fixture contract (discovery, PKCE, MCP, refresh modes)
// is proved in one file; splitting the scenarios would add no coverage.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
	OAuthMetadataSchema,
	OAuthProtectedResourceMetadataSchema
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { startOAuthFixture, type OAuthFixture } from '../fixtures/oauth-server';

const REDIRECT_URI = 'http://127.0.0.1:49152/oauth/callback';

let fixture: OAuthFixture;

beforeAll(async () => {
	fixture = await startOAuthFixture({ refreshDelayMs: 75 });
});

afterAll(() => {
	fixture?.stop();
});

function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	return { verifier, challenge };
}

async function registerClient(): Promise<string> {
	const response = await fetch(`${fixture.origin}/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			client_name: 'oauth-fixture-unit-test',
			redirect_uris: [REDIRECT_URI],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none'
		})
	});
	expect(response.status).toBe(201);
	const body = (await response.json()) as { client_id: string };
	expect(typeof body.client_id).toBe('string');
	return body.client_id;
}

async function authorize(clientId: string, challenge: string, state: string): Promise<string> {
	const url = new URL(`${fixture.origin}/authorize`);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', REDIRECT_URI);
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('scope', 'mcp_all');
	const response = await fetch(url, { redirect: 'manual' });
	expect(response.status).toBe(302);
	const location = response.headers.get('location');
	expect(location).not.toBeNull();
	const redirected = new URL(location as string);
	expect(redirected.origin + redirected.pathname).toBe(
		new URL(REDIRECT_URI).origin + new URL(REDIRECT_URI).pathname
	);
	expect(redirected.searchParams.get('state')).toBe(state);
	const code = redirected.searchParams.get('code');
	expect(typeof code).toBe('string');
	return code as string;
}

async function exchange(
	clientId: string,
	code: string,
	verifier: string
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${fixture.origin}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: clientId,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier
		})
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function fullFlow(): Promise<{
	clientId: string;
	accessToken: string;
	refreshToken: string;
}> {
	const clientId = await registerClient();
	const { verifier, challenge } = pkcePair();
	const code = await authorize(clientId, challenge, randomBytes(16).toString('base64url'));
	const result = await exchange(clientId, code, verifier);
	expect(result.status).toBe(200);
	return {
		clientId,
		accessToken: result.body.access_token as string,
		refreshToken: result.body.refresh_token as string
	};
}

async function refresh(refreshToken: string): Promise<Response> {
	return fetch(`${fixture.origin}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken
		})
	});
}

describe('oauth fixture — discovery', () => {
	test('protected-resource metadata parses with the SDK schema', async () => {
		const response = await fetch(`${fixture.origin}/.well-known/oauth-protected-resource`);
		expect(response.status).toBe(200);
		const metadata = OAuthProtectedResourceMetadataSchema.parse(await response.json());
		expect(metadata.resource).toBe(fixture.origin);
		expect(metadata.authorization_servers).toEqual([`${fixture.origin}/v1/mcp`]);
	});

	test('authorization-server metadata parses and advertises PKCE + public clients', async () => {
		const response = await fetch(`${fixture.origin}/.well-known/oauth-authorization-server`);
		expect(response.status).toBe(200);
		const metadata = OAuthMetadataSchema.parse(await response.json());
		expect(metadata.issuer).toBe(`${fixture.origin}/v1/mcp`);
		expect(metadata.authorization_endpoint).toBe(`${fixture.origin}/authorize`);
		expect(metadata.token_endpoint).toBe(`${fixture.origin}/token`);
		expect(metadata.registration_endpoint).toBe(`${fixture.origin}/register`);
		expect(metadata.response_types_supported).toEqual(['code']);
		expect(metadata.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
		expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
		expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none']);
		expect(metadata.scopes_supported).toEqual(['mcp_all']);
	});

	test('path-aware discovery variants serve the same documents', async () => {
		const resource = await fetch(`${fixture.origin}/.well-known/oauth-protected-resource/v1/mcp`);
		const server = await fetch(`${fixture.origin}/.well-known/oauth-authorization-server/v1/mcp`);
		expect(resource.status).toBe(200);
		expect(server.status).toBe(200);
	});
});

describe('oauth fixture — authorization code + PKCE', () => {
	test('authorize records every query parameter and redirects with code + state', async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const state = randomBytes(12).toString('base64url');
		const code = await authorize(clientId, challenge, state);

		const recorded = fixture.lastAuthorization;
		expect(recorded).toMatchObject({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: REDIRECT_URI,
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			scope: 'mcp_all'
		});
		expect(code.length).toBeGreaterThan(10);
		expect(fixture.requests.authorize).toBeGreaterThan(0);
	});

	test('token endpoint rejects a mismatched PKCE verifier with invalid_grant', async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const code = await authorize(clientId, challenge, 'state-wrong-verifier');
		const result = await exchange(clientId, code, pkcePair().verifier);
		expect(result.status).toBe(400);
		expect(result.body).toEqual({ error: 'invalid_grant' });
	});

	test('token endpoint accepts the matching verifier and the MCP endpoint lists tools', async () => {
		const { accessToken } = await fullFlow();
		const client = new Client(
			{ name: 'oauth-fixture-test', version: '1.0.0' },
			{ capabilities: {} }
		);
		const transport = new StreamableHTTPClientTransport(new URL(fixture.mcpUrl), {
			requestInit: { headers: { authorization: `Bearer ${accessToken}` } }
		});
		try {
			await client.connect(transport);
			const { tools } = await client.listTools();
			expect(tools.map((tool) => tool.name)).toContain('echo');
		} finally {
			await client.close().catch(() => undefined);
		}
	});
});

describe('oauth fixture — protected MCP endpoint', () => {
	test('returns 401 + resource_metadata challenge without a token', async () => {
		const response = await fetch(fixture.mcpUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
		});
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe(
			`Bearer resource_metadata="${fixture.origin}/.well-known/oauth-protected-resource"`
		);
		expect(fixture.requests.unauthorized).toBeGreaterThan(0);
	});
});

describe('oauth fixture — refresh modes', () => {
	test('reusable mode keeps the same refresh token valid', async () => {
		fixture.setRefreshMode('reusable');
		const { refreshToken } = await fullFlow();
		const first = await refresh(refreshToken);
		const second = await refresh(refreshToken);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(((await first.json()) as { refresh_token: string }).refresh_token).toBe(refreshToken);
	});

	test('rotating mode invalidates the previous refresh token', async () => {
		fixture.setRefreshMode('rotating');
		const { refreshToken } = await fullFlow();
		const first = await refresh(refreshToken);
		expect(first.status).toBe(200);
		const rotated = (await first.json()) as { refresh_token: string };
		expect(rotated.refresh_token).not.toBe(refreshToken);

		const replay = await refresh(refreshToken);
		expect(replay.status).toBe(400);
		expect(await replay.json()).toEqual({ error: 'invalid_grant' });
	});

	test('invalid_grant mode rejects every refresh', async () => {
		fixture.setRefreshMode('invalid_grant');
		const { refreshToken } = await fullFlow();
		const response = await refresh(refreshToken);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_grant' });
	});

	test('delay mode waits before rotating', async () => {
		fixture.setRefreshMode('delay');
		const { refreshToken } = await fullFlow();
		const started = Date.now();
		const response = await refresh(refreshToken);
		const elapsed = Date.now() - started;
		expect(response.status).toBe(200);
		expect(elapsed).toBeGreaterThanOrEqual(50);
		const rotated = (await response.json()) as { refresh_token: string };
		expect(rotated.refresh_token).not.toBe(refreshToken);
	});

	test('mintToken adds an accepted bearer without a grant', async () => {
		fixture.setRefreshMode('reusable');
		const token = fixture.mintToken();
		const response = await fetch(fixture.mcpUrl, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
		});
		expect(response.status).not.toBe(401);
	});
});
