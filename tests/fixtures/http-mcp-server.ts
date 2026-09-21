/**
 * Test fixture: the shared MCP surface served over Streamable HTTP.
 *
 * Runs in-process on loopback (the SSRF guard exempts loopback for http://), so
 * remote-transport tests exercise a real MCP server without network access.
 * It is stateless and answers with plain JSON — the most compatible shape, and
 * what most hosted MCP endpoints speak today.
 *
 * Two gotchas baked into this file, both discovered the hard way:
 *   - do NOT close the per-request server when `request.signal` aborts: Bun
 *     settles that signal as soon as the request body is consumed, which
 *     truncates slow tool calls (the client then times out).
 *   - do NOT stream SSE here without draining it; `enableJsonResponse` keeps the
 *     response a single payload that survives the per-request lifecycle.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerFixtureTools } from './register-tools.js';

export type FixtureHttpServer = {
	url: string;
	port: number;
	requests: {
		total: number;
		authorized: number;
		lastAuthorization?: string | null;
		lastApiKey?: string | null;
	};
	stop(): void;
};

export type FixtureHttpOptions = {
	/** When set, requests must carry `Authorization: Bearer <token>`. */
	requireBearer?: string;
	/** When set, requests must carry this exact `Authorization` value (no prefix added). */
	requireAuthorizationRaw?: string;
	/** Respond with this status before any MCP handling (simulates a dead upstream). */
	failWith?: number;
	port?: number;
};

export async function startFixtureHttpServer(
	options: FixtureHttpOptions = {}
): Promise<FixtureHttpServer> {
	// one McpServer per request, released together when the fixture stops
	const liveServers = new Set<McpServer>();
	const requests = {
		total: 0,
		authorized: 0,
		lastAuthorization: null as string | null,
		lastApiKey: null as string | null
	};

	const handle = async (request: Request): Promise<Response> => {
		requests.total += 1;
		const authorization = request.headers.get('authorization');
		requests.lastAuthorization = authorization;
		requests.lastApiKey = request.headers.get('x-api-key');

		if (options.failWith) return new Response('upstream offline', { status: options.failWith });

		const url = new URL(request.url);
		if (url.pathname !== '/mcp') return new Response('not found', { status: 404 });

		const expected =
			options.requireAuthorizationRaw ??
			(options.requireBearer ? `Bearer ${options.requireBearer}` : undefined);
		if (expected !== undefined && authorization !== expected) {
			requests.authorized += 0;
			return new Response('unauthorized', { status: 401 });
		}
		requests.authorized += 1;

		if (request.method !== 'POST') {
			return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
		}

		const server = new McpServer(
			{ name: 'fixture-upstream', version: '1.0.0' },
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
	};

	const server = Bun.serve({
		port: options.port ?? 0,
		fetch: (request) =>
			handle(request).catch(
				(error: unknown) =>
					// the SDK reports aborted requests as rejections; surface them as 500
					new Response(`fixture error: ${(error as Error)?.message ?? error}`, { status: 500 })
			)
	});

	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		port: server.port as number,
		requests,
		stop() {
			server.stop(true);
			for (const live of liveServers) void live.close().catch(() => undefined);
			liveServers.clear();
		}
	};
}
