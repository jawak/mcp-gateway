/**
 * Test fixture: a local OAuth 2.0 authorization server with a protected MCP
 * endpoint, for the generic `authMode: 'oauth'` upstream tests.
 *
 * Everything runs in-process on loopback — no real network and no Datadog
 * endpoints. The discovery documents mirror the shapes the MCP SDK expects
 * (RFC 9728 protected-resource metadata + RFC 8414 authorization-server
 * metadata), and `/authorize` + `/token` implement the authorization-code and
 * refresh-token grants with PKCE S256.
 *
 * Refresh behaviour is switchable at runtime so the refresh/retry tests can
 * cover reusable, rotating, `invalid_grant`, and delayed token endpoints
 * without restarting the fixture.
 */
// allow: SIZE_OK — one in-process fixture must serve discovery, DCR, authorize,
// token, and the protected MCP endpoint; splitting would add files outside this task.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createHash, randomBytes } from 'node:crypto';
import { registerFixtureTools } from './register-tools.js';

export type RefreshMode = 'reusable' | 'rotating' | 'invalid_grant' | 'delay';

export type OAuthFixtureOptions = {
	refreshMode?: RefreshMode;
	/** Used by `delay` mode to widen the refresh race window. */
	refreshDelayMs?: number;
	accessTokenTtlSeconds?: number;
	scope?: string;
	port?: number;
};

export type AuthorizationRecord = {
	response_type: string | null;
	client_id: string | null;
	redirect_uri: string | null;
	state: string | null;
	code_challenge: string | null;
	code_challenge_method: string | null;
	scope: string | null;
};

export type TokenRequestRecord = {
	grant_type: string | null;
	client_id: string | null;
	code?: string;
	refresh_token?: string;
	code_verifier?: string;
	status: number;
	error?: string;
};

export type OAuthFixture = {
	origin: string;
	/** Protected MCP endpoint (Streamable HTTP JSON-RPC). */
	mcpUrl: string;
	/** Alias of `mcpUrl`, matching the other HTTP fixture's shape. */
	url: string;
	requests: {
		register: number;
		authorize: number;
		token: number;
		mcp: number;
		unauthorized: number;
	};
	registrations: Array<Record<string, unknown>>;
	authorizations: AuthorizationRecord[];
	tokenRequests: TokenRequestRecord[];
	lastAuthorization: AuthorizationRecord | null;
	/** Add a bearer token the protected MCP endpoint will accept. */
	mintToken(value?: string): string;
	setRefreshMode(mode: RefreshMode): void;
	setAccessTokenTtl(seconds: number): void;
	stop(): void;
};

type AuthorizationCode = {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	scope: string;
	state: string | null;
};

type RefreshTokenState = { clientId: string; scope: string; active: boolean };

const randomToken = (prefix: string): string =>
	`${prefix}_${randomBytes(24).toString('base64url')}`;

const s256 = (verifier: string): string =>
	createHash('sha256').update(verifier).digest('base64url');

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' }
	});

const methodNotAllowed = (allow: string): Response =>
	new Response('method not allowed', { status: 405, headers: { allow } });

export async function startOAuthFixture(options: OAuthFixtureOptions = {}): Promise<OAuthFixture> {
	const scope = options.scope ?? 'mcp_all';
	let refreshMode = options.refreshMode ?? 'reusable';
	const refreshDelayMs = options.refreshDelayMs ?? 25;
	let accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600;

	const liveServers = new Set<McpServer>();
	const clients = new Map<string, { redirectUris: string[] }>();
	const codes = new Map<string, AuthorizationCode>();
	const refreshTokens = new Map<string, RefreshTokenState>();
	const acceptedTokens = new Set<string>();

	const requests = { register: 0, authorize: 0, token: 0, mcp: 0, unauthorized: 0 };
	const registrations: Array<Record<string, unknown>> = [];
	const authorizations: AuthorizationRecord[] = [];
	const tokenRequests: TokenRequestRecord[] = [];

	const resourceMetadataUrl = (origin: string): string =>
		`${origin}/.well-known/oauth-protected-resource`;

	const protectedResourceMetadata = (origin: string): Record<string, unknown> => ({
		resource: origin,
		authorization_servers: [`${origin}/v1/mcp`],
		scopes_supported: [scope],
		bearer_methods_supported: ['header']
	});

	const authorizationServerMetadata = (origin: string): Record<string, unknown> => ({
		issuer: `${origin}/v1/mcp`,
		authorization_endpoint: `${origin}/authorize`,
		token_endpoint: `${origin}/token`,
		registration_endpoint: `${origin}/register`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		pkce_required: true,
		scopes_supported: [scope],
		token_endpoint_auth_methods_supported: ['none']
	});

	function issueTokens(clientId: string, grantedScope: string, refreshToken?: string) {
		const accessToken = randomToken('at');
		acceptedTokens.add(accessToken);
		const refresh = refreshToken ?? randomToken('rt');
		if (!refreshToken) refreshTokens.set(refresh, { clientId, scope: grantedScope, active: true });
		return {
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: accessTokenTtlSeconds,
			scope: grantedScope,
			refresh_token: refresh
		};
	}

	function tokenError(record: TokenRequestRecord, error: string): Response {
		record.status = 400;
		record.error = error;
		tokenRequests.push(record);
		return json({ error }, 400);
	}

	async function handleRegister(request: Request): Promise<Response> {
		if (request.method !== 'POST') return methodNotAllowed('POST');
		requests.register += 1;
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		registrations.push(body);
		const clientId = randomToken('client');
		const redirectUris = Array.isArray(body.redirect_uris)
			? body.redirect_uris.filter((value): value is string => typeof value === 'string')
			: [];
		clients.set(clientId, { redirectUris });
		return json(
			{
				client_id: clientId,
				client_id_issued_at: Math.floor(Date.now() / 1000),
				redirect_uris: redirectUris,
				token_endpoint_auth_method: 'none',
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				client_name: typeof body.client_name === 'string' ? body.client_name : undefined
			},
			201
		);
	}

	function handleAuthorize(url: URL): Response {
		requests.authorize += 1;
		const params = url.searchParams;
		const record: AuthorizationRecord = {
			response_type: params.get('response_type'),
			client_id: params.get('client_id'),
			redirect_uri: params.get('redirect_uri'),
			state: params.get('state'),
			code_challenge: params.get('code_challenge'),
			code_challenge_method: params.get('code_challenge_method'),
			scope: params.get('scope')
		};
		authorizations.push(record);
		if (!record.response_type || !record.client_id || !record.redirect_uri) {
			return json({ error: 'invalid_request' }, 400);
		}
		if (record.response_type !== 'code') {
			return json({ error: 'unsupported_response_type' }, 400);
		}
		if (record.code_challenge_method !== 'S256' || !record.code_challenge) {
			return json({ error: 'invalid_request', error_description: 'PKCE S256 required' }, 400);
		}

		const code = randomToken('code');
		codes.set(code, {
			clientId: record.client_id,
			redirectUri: record.redirect_uri,
			codeChallenge: record.code_challenge,
			scope: record.scope ?? scope,
			state: record.state
		});
		const location = new URL(record.redirect_uri);
		location.searchParams.set('code', code);
		if (record.state !== null) location.searchParams.set('state', record.state);
		return new Response(null, { status: 302, headers: { location: location.toString() } });
	}

	async function handleToken(request: Request): Promise<Response> {
		if (request.method !== 'POST') return methodNotAllowed('POST');
		requests.token += 1;
		const form = new URLSearchParams(await request.text());
		const grantType = form.get('grant_type');
		const record: TokenRequestRecord = {
			grant_type: grantType,
			client_id: form.get('client_id'),
			status: 0
		};

		if (grantType === 'authorization_code') {
			const codeValue = form.get('code');
			const verifier = form.get('code_verifier');
			record.code = codeValue ?? undefined;
			record.code_verifier = verifier ?? undefined;
			const code = codeValue ? codes.get(codeValue) : undefined;
			if (!code) return tokenError(record, 'invalid_grant');
			// Authorization codes are single-use, even when the verifier is wrong.
			codes.delete(codeValue as string);
			if (code.clientId !== record.client_id) return tokenError(record, 'invalid_grant');
			if (form.get('redirect_uri') !== code.redirectUri) return tokenError(record, 'invalid_grant');
			if (!verifier || s256(verifier) !== code.codeChallenge) {
				return tokenError(record, 'invalid_grant');
			}
			record.status = 200;
			tokenRequests.push(record);
			return json(issueTokens(code.clientId, code.scope));
		}

		if (grantType === 'refresh_token') {
			const refreshValue = form.get('refresh_token') ?? '';
			record.refresh_token = refreshValue;
			if (refreshMode === 'invalid_grant') return tokenError(record, 'invalid_grant');
			const state = refreshTokens.get(refreshValue);
			if (!state || !state.active) return tokenError(record, 'invalid_grant');
			if (refreshMode === 'delay') {
				await new Promise((resolve) => setTimeout(resolve, refreshDelayMs));
			}
			if (refreshMode === 'reusable')
				return json(issueTokens(state.clientId, state.scope, refreshValue));
			state.active = false;
			record.status = 200;
			tokenRequests.push(record);
			return json(issueTokens(state.clientId, state.scope));
		}

		return tokenError(record, 'unsupported_grant_type');
	}

	async function handleMcp(request: Request): Promise<Response> {
		requests.mcp += 1;
		const origin = new URL(request.url).origin;
		const authorization = request.headers.get('authorization') ?? '';
		const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
		if (!acceptedTokens.has(token)) {
			requests.unauthorized += 1;
			return new Response('unauthorized', {
				status: 401,
				headers: { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl(origin)}"` }
			});
		}
		if (request.method !== 'POST') return methodNotAllowed('POST');

		const server = new McpServer(
			{ name: 'oauth-fixture-upstream', version: '1.0.0' },
			{ capabilities: { logging: {} } }
		);
		liveServers.add(server);
		registerFixtureTools(server);
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true
		});
		await server.connect(transport);
		return transport.handleRequest(request);
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		if (
			path === '/.well-known/oauth-protected-resource' ||
			path.startsWith('/.well-known/oauth-protected-resource/')
		) {
			return request.method === 'GET'
				? json(protectedResourceMetadata(url.origin))
				: methodNotAllowed('GET');
		}
		if (
			path === '/.well-known/oauth-authorization-server' ||
			path.startsWith('/.well-known/oauth-authorization-server/')
		) {
			return request.method === 'GET'
				? json(authorizationServerMetadata(url.origin))
				: methodNotAllowed('GET');
		}
		if (path === '/register') return handleRegister(request);
		if (path === '/authorize') return handleAuthorize(url);
		if (path === '/token') return handleToken(request);
		if (path === '/mcp') return handleMcp(request);
		return new Response('not found', { status: 404 });
	}

	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: options.port ?? 0,
		fetch: (request) =>
			handle(request).catch(
				(error: unknown) =>
					new Response(`oauth fixture error: ${(error as Error)?.message ?? error}`, {
						status: 500
					})
			)
	});

	const origin = `http://127.0.0.1:${server.port as number}`;
	const mcpUrl = `${origin}/mcp`;

	return {
		origin,
		mcpUrl,
		url: mcpUrl,
		requests,
		registrations,
		authorizations,
		tokenRequests,
		get lastAuthorization() {
			return authorizations.at(-1) ?? null;
		},
		mintToken(value?: string) {
			const token = value ?? randomToken('at');
			acceptedTokens.add(token);
			return token;
		},
		setRefreshMode(mode: RefreshMode) {
			refreshMode = mode;
		},
		setAccessTokenTtl(seconds: number) {
			accessTokenTtlSeconds = seconds;
		},
		stop() {
			server.stop(true);
			for (const live of liveServers) void live.close().catch(() => undefined);
			liveServers.clear();
		}
	};
}
