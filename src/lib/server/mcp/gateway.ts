/**
 * MCP endpoint (T-12).
 *
 * One `/mcp` route serving many upstreams. Design decisions that matter:
 *
 *  - **Low-level `Server`, not `McpServer`:** the gateway aggregates, namespaces
 *    and filters across upstreams, so it must own `tools/list`, `resources/*`
 *    and `prompts/*` outright instead of registering individual tools.
 *  - **One server + transport per session:** `Mcp-Session-Id` scopes state and the
 *    per-profile tool view; a session never sees another key's scope.
 *  - **JSON responses by default:** most clients and reverse proxies handle a
 *    plain response more reliably; SSE stays available for streaming and
 *    server-initiated traffic, kept warm by `keepAliveMs`.
 *  - **Resumability** via `MemoryEventStore`, so a reconnecting client can replay
 *    what it missed.
 *  - **Error mapping:** unknown tool → `-32602` (invalid params); a tool outside
 *    the key's scope → `-32601` (method not found) so scope isolation is
 *    indistinguishable from "this tool does not exist"; upstream failures come
 *    back as `isError: true` results, which models handle far better than a
 *    JSON-RPC error (MCP treats execution failures as results, not protocol errors).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	McpError,
	ErrorCode
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { GatewayBackend, McpCaller } from './backend.ts';
import { NotAllowedError, ToolNotFoundError, UpstreamUnavailableError } from './backend.ts';
import { MemoryEventStore } from './event-store.ts';
import { SessionRegistry } from './session.ts';
import type { RequestContext } from '../../../handle.ts';
import { uuidv7 } from '../../shared/ids.ts';
import { logger as rootLogger, type Logger } from '../observability/logger.ts';
import { redactString } from '../security/redact.ts';

/** `authenticate` either returns the caller or a ready-made HTTP rejection. */
export type AuthResult = McpCaller | { response: Response };
export type Authenticate = (request: Request, context: RequestContext) => Promise<AuthResult>;

export type McpEndpointOptions = {
	/** Bearer API key → caller identity, or an already-built failure response. */
	authenticate: Authenticate;
	backend: GatewayBackend;
	sessions?: SessionRegistry;
	eventStore?: MemoryEventStore;
	/** Answer POSTs with plain JSON instead of an SSE stream (default true). */
	enableJsonResponse?: boolean;
	keepAliveMs?: number;
	serverInfo?: { name: string; version: string };
	instructions?: string;
	logger?: Logger;
};

const SESSION_HEADER = 'Mcp-Session-Id';

export type McpEndpoint = {
	handle(request: Request, context: RequestContext): Promise<Response>;
	sessions: SessionRegistry;
	eventStore: MemoryEventStore;
};

export function createMcpEndpoint(options: McpEndpointOptions): McpEndpoint {
	const log = (options.logger ?? rootLogger).child({ component: 'mcp-endpoint' });
	const sessions = options.sessions ?? new SessionRegistry();
	const eventStore = options.eventStore ?? new MemoryEventStore();
	const serverInfo = options.serverInfo ?? { name: 'mcp-gateway', version: '0.1.0' };

	async function handle(request: Request, context: RequestContext): Promise<Response> {
		const authenticated = await options.authenticate(request, context);
		if ('response' in authenticated) return authenticated.response;
		const caller: McpCaller = {
			...authenticated,
			requestId: context.requestId,
			clientAddress: context.clientAddress
		};

		const method = request.method.toUpperCase();
		const sessionId = request.headers.get(SESSION_HEADER) ?? request.headers.get('mcp-session-id');

		// Every request except the handshake must carry a session id we issued.
		if (method !== 'POST' || sessionId) {
			const session = sessions.get(sessionId);
			if (!session)
				return jsonRpcError(
					404,
					-32000,
					`unknown or expired session: ${sessionId ?? 'none given'}`
				);
			if (method === 'DELETE') {
				const response = await session.transport.handleRequest(request, {
					authInfo: authInfoFor(session.caller)
				});
				await sessions.close(session.id, 'client');
				return response;
			}
			return session.transport.handleRequest(request, { authInfo: authInfoFor(session.caller) });
		}

		return handshake(caller, request);
	}

	/** Create the per-session server + transport, then run the handshake. */
	async function handshake(caller: McpCaller, request: Request): Promise<Response> {
		const capabilities = {
			tools: { listChanged: true },
			resources: {
				subscribe: options.backend.supportsResourceSubscribe?.(caller) ?? false,
				listChanged: true
			},
			prompts: { listChanged: true }
		};
		const server = new Server(serverInfo, { capabilities, instructions: options.instructions });
		let sessionId: string | undefined;
		let unwatch: () => void = () => undefined;

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => uuidv7(),
			enableJsonResponse: options.enableJsonResponse ?? true,
			keepAliveMs: options.keepAliveMs ?? 15_000,
			eventStore,
			onsessioninitialized: (id) => {
				sessionId = id;
				caller.protocolVersion = requestProtocolHint(request) ?? caller.protocolVersion;
				const entry = sessions.register({ id, caller, server, transport, unwatch });
				// push list-changed notifications to this session while it lives
				unwatch =
					options.backend.watch?.(id, caller, async (method) => {
						await server.notification({ method } as never);
					}) ?? (() => undefined);
				entry.unwatch = unwatch;
			},
			onsessionclosed: (id) => {
				eventStore.releaseStream(id);
				void sessions.close(id, 'client');
			}
		});

		registerHandlers(transport, server, options.backend, caller, log);
		// Without this the transport has no protocol to dispatch to and every
		// request hangs until the client gives up.
		await server.connect(transport);

		try {
			const response = await transport.handleRequest(request, { authInfo: authInfoFor(caller) });
			// Give the transport's onsessioninitialized callback a turn: if the
			// handshake never materialised (bad params, unsupported version), drop the
			// server instance instead of leaking it.
			await new Promise((resolve) => setTimeout(resolve, 0));
			if (!sessionId) {
				await Promise.allSettled([transport.close(), server.close()]);
			}
			return response;
		} catch (error) {
			await Promise.allSettled([transport.close(), server.close()]);
			log.error({ err: error, requestId: caller.requestId }, 'handshake failed');
			throw error;
		}
	}

	return { handle, sessions, eventStore };
}

/** The protocol version the client asked for, best effort (for logging). */
function requestProtocolHint(request: Request): string | undefined {
	// initialize params are read by the SDK; this only mirrors what it will pick
	const header = request.headers.get('mcp-protocol-version');
	return header ?? undefined;
}

/** Wire the MCP request handlers onto one session's server. */
function registerHandlers(
	transport: WebStandardStreamableHTTPServerTransport,
	server: Server,
	backend: GatewayBackend,
	caller: McpCaller,
	log: Logger
): void {
	server.setRequestHandler(ListToolsRequestSchema, async (request) => {
		const page = await backend.listTools(caller, { cursor: request.params?.cursor });
		return {
			tools: page.items.map((tool) => ({
				name: tool.name,
				...(tool.title ? { title: tool.title } : {}),
				...(tool.description ? { description: tool.description } : {}),
				inputSchema: tool.inputSchema,
				...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
				...(tool.annotations ? { annotations: tool.annotations } : {}),
				// clients that understand _meta learn where the tool really lives
				_meta: { 'mcp-gateway': tool.meta }
			})),
			...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
		};
	});

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const params = request.params;
		const progressToken = params._meta?.progressToken;
		try {
			const result = await backend.callTool(
				caller,
				params.name,
				params.arguments as Record<string, unknown> | undefined,
				{
					signal: extra.signal,
					reportProgress:
						progressToken === undefined
							? undefined
							: async (progress) => {
									// JSON-response mode has no channel to carry notifications;
									// a client that cannot receive progress must not fail the call.
									await extra
										.sendNotification({
											method: 'notifications/progress',
											params: {
												progressToken,
												progress: progress.progress,
												...(progress.total !== undefined ? { total: progress.total } : {}),
												...(progress.message ? { message: progress.message } : {})
											}
										})
										.catch(() => undefined);
								}
				}
			);
			return result as never;
		} catch (error) {
			if (error instanceof ToolNotFoundError)
				throw new McpError(ErrorCode.InvalidParams, error.message);
			// scope isolation must look like "no such tool"
			if (error instanceof NotAllowedError)
				throw new McpError(ErrorCode.MethodNotFound, 'method not found');
			const text = redactString(messageOf(error));
			if (error instanceof UpstreamUnavailableError)
				log.warn({ requestId: caller.requestId, reason: text }, 'upstream unavailable');
			return { isError: true, content: [{ type: 'text', text }] } as never;
		}
	});

	server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
		const page = await backend.listResources(caller, { cursor: request.params?.cursor });
		return {
			resources: page.items.map((resource) => ({
				uri: resource.uri,
				name: resource.name,
				...(resource.title ? { title: resource.title } : {}),
				...(resource.description ? { description: resource.description } : {}),
				...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
				_meta: { 'mcp-gateway': resource.meta }
			})),
			...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
		};
	});

	server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
		const page = await backend.listResourceTemplates(caller, { cursor: request.params?.cursor });
		return {
			resourceTemplates: page.items.map((template) => ({
				uriTemplate: template.uriTemplate,
				name: template.name,
				...(template.title ? { title: template.title } : {}),
				...(template.description ? { description: template.description } : {}),
				...(template.mimeType ? { mimeType: template.mimeType } : {})
			})),
			...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
		};
	});

	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		try {
			return (await backend.readResource(caller, request.params.uri)) as never;
		} catch (error) {
			if (error instanceof NotAllowedError)
				throw new McpError(ErrorCode.MethodNotFound, 'method not found');
			throw error instanceof McpError
				? error
				: new McpError(ErrorCode.InternalError, redactString(messageOf(error)));
		}
	});

	server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
		const page = await backend.listPrompts(caller, { cursor: request.params?.cursor });
		return {
			prompts: page.items.map((prompt) => ({
				name: prompt.name,
				...(prompt.title ? { title: prompt.title } : {}),
				...(prompt.description ? { description: prompt.description } : {}),
				...(prompt.arguments ? { arguments: prompt.arguments } : {}),
				_meta: { 'mcp-gateway': prompt.meta }
			})),
			...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
		};
	});

	server.setRequestHandler(GetPromptRequestSchema, async (request) => {
		try {
			return (await backend.getPrompt(
				caller,
				request.params.name,
				request.params.arguments as Record<string, unknown> | undefined
			)) as never;
		} catch (error) {
			if (error instanceof ToolNotFoundError)
				throw new McpError(ErrorCode.InvalidParams, error.message);
			if (error instanceof NotAllowedError)
				throw new McpError(ErrorCode.MethodNotFound, 'method not found');
			throw error instanceof McpError
				? error
				: new McpError(ErrorCode.InternalError, redactString(messageOf(error)));
		}
	});

	void transport;
}

/**
 * The SDK hands request handlers an `AuthInfo`. We never put the raw key in
 * there — the identifier is enough for logging and future OAuth work.
 */
function authInfoFor(caller: McpCaller): AuthInfo {
	return {
		token: `api-key:${caller.apiKeyId}`,
		clientId: caller.keyName,
		scopes: [`profile:${caller.profileId}`],
		extra: {
			requestId: caller.requestId,
			clientAddress: caller.clientAddress,
			protocolVersion: caller.protocolVersion,
			clientInfo: caller.clientInfo
		}
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function jsonRpcError(httpStatus: number, code: number, message: string): Response {
	return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), {
		status: httpStatus,
		headers: { 'content-type': 'application/json' }
	});
}
