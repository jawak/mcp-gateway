/**
 * MCP endpoint tests (T-12): handshake, version negotiation, session lifecycle,
 * capability advertisement, error mapping and progress — driven by the real SDK
 * client over a real HTTP socket.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createMcpEndpoint, type Authenticate } from '../../src/lib/server/mcp/gateway';
import type { GatewayBackend, McpCaller } from '../../src/lib/server/mcp/backend';
import { NotAllowedError, ToolNotFoundError } from '../../src/lib/server/mcp/backend';
import { SessionRegistry } from '../../src/lib/server/mcp/session';
import { MemoryEventStore } from '../../src/lib/server/mcp/event-store';
import { UpstreamUnavailableError } from '../../src/lib/server/mcp/backend';

const CALLER: Omit<McpCaller, 'requestId' | 'clientAddress'> = {
	apiKeyId: 'key-1',
	keyName: 'laptop',
	profileId: 'profile-1'
};

/** Backend double: everything the protocol needs, no upstreams involved. */
function stubBackend(
	behaviour: Partial<GatewayBackend> = {}
): GatewayBackend & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		listTools: async () => {
			calls.push('listTools');
			return {
				items: [
					{
						name: 'github__create_pr',
						description: 'Open a pull request',
						inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
						meta: { upstream: 'github', upstreamTool: 'create_pr', health: 'healthy' }
					},
					{
						name: 'sentry__list_events',
						inputSchema: { type: 'object' },
						meta: { upstream: 'sentry', upstreamTool: 'list_events', health: 'healthy' }
					}
				]
			};
		},
		callTool: async (_caller, name, args) => {
			calls.push(`callTool:${name}`);
			if (name === 'github__create_pr') {
				return {
					content: [{ type: 'text', text: `opened ${(args as { title?: string })?.title ?? '?'}` }]
				};
			}
			if (name === 'github__delete_repo') throw new NotAllowedError(name);
			if (name === 'github__boom') throw new UpstreamUnavailableError('github', 'connection reset');
			throw new ToolNotFoundError(name);
		},
		listResources: async () => ({
			items: [
				{
					uri: 'github://prs',
					name: 'prs',
					mimeType: 'application/json',
					meta: { upstream: 'github' }
				}
			]
		}),
		listResourceTemplates: async () => ({
			items: [{ uriTemplate: 'github://repo/{owner}', name: 'repo', meta: { upstream: 'github' } }]
		}),
		readResource: async (_caller, uri) => ({
			contents: [{ uri, mimeType: 'application/json', text: '[]' }]
		}),
		listPrompts: async () => ({
			items: [{ name: 'github__review', description: 'Review a PR', meta: { upstream: 'github' } }]
		}),
		getPrompt: async (_caller, name, args) => ({
			description: 'Review a PR',
			messages: [
				{
					role: 'user',
					content: { type: 'text', text: `review ${(args as { pr?: string })?.pr ?? ''}` }
				}
			]
		}),
		...behaviour
	} as GatewayBackend & { calls: string[] };
}

const endpoints: Array<{ close: () => void; url: string; sessions: SessionRegistry }> = [];

async function serve(options: {
	backend: GatewayBackend;
	authenticate?: Authenticate;
	enableJsonResponse?: boolean;
	eventStore?: MemoryEventStore;
}): Promise<{ url: string; sessions: SessionRegistry; close: () => void }> {
	const sessions = new SessionRegistry();
	const endpoint = createMcpEndpoint({
		backend: options.backend,
		authenticate:
			options.authenticate ??
			(async () => ({ ...CALLER, requestId: 'r1', clientAddress: '127.0.0.1' })),
		sessions,
		enableJsonResponse: options.enableJsonResponse ?? true,
		eventStore: options.eventStore
	});
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path !== '/mcp') return new Response('not found', { status: 404 });
			return endpoint.handle(request, { requestId: 'req-test', clientAddress: '127.0.0.1' });
		}
	});
	const url = `http://127.0.0.1:${server.port}/mcp`;
	const entry = { url, sessions, close: () => server.stop(true) };
	endpoints.push(entry);
	return entry;
}

async function connect(
	url: string,
	options: {
		protocolVersion?: string;
		clientInfo?: { name: string; version: string };
		accessToken?: string;
	} = {}
): Promise<{
	client: Client;
	transport: StreamableHTTPClientTransport;
	sessionId: () => string | undefined;
}> {
	const client = new Client(options.clientInfo ?? { name: 'test-client', version: '9.9' }, {
		capabilities: {}
	});
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: options.accessToken
			? { headers: { authorization: `Bearer ${options.accessToken}` } }
			: undefined
	});
	await client.connect(transport);
	return { client, transport, sessionId: () => transport.sessionId };
}

afterAll(async () => {
	for (const entry of endpoints) entry.close();
});

describe('handshake and negotiation', () => {
	test('initialize returns a session id, server info and gateway capabilities', async () => {
		const { url } = await serve({ backend: stubBackend() });
		const { client, sessionId } = await connect(url);
		expect(sessionId()).toBeTruthy();
		expect(client.getServerVersion()?.name).toBe('mcp-gateway');
		const capabilities = client.getServerCapabilities() ?? {};
		expect((capabilities as Record<string, unknown>).tools).toEqual({ listChanged: true });
		expect((capabilities as Record<string, unknown>).prompts).toEqual({ listChanged: true });
		expect((capabilities as Record<string, unknown>).resources).toMatchObject({
			listChanged: true,
			subscribe: false
		});
		await client.close();
	});

	test('an older client protocol is honoured, not forced forward', async () => {
		const { url } = await serve({ backend: stubBackend() });
		const raw = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2024-11-05',
					capabilities: {},
					clientInfo: { name: 'ancient', version: '1' }
				}
			})
		});
		expect(raw.status).toBe(200);
		const body = (await raw.json()) as { result: { protocolVersion: string } };
		expect(body.result.protocolVersion).toBe('2024-11-05');
	});

	test('the raw API key never reaches the handler auth info', async () => {
		const seen: unknown[] = [];
		const backend = stubBackend({
			listTools: async (caller) => {
				seen.push(caller);
				return { items: [] };
			}
		});
		const { url } = await serve({ backend });
		const { client } = await connect(url);
		await client.listTools();
		const caller = seen[0] as McpCaller;
		expect(caller).toMatchObject({
			apiKeyId: 'key-1',
			keyName: 'laptop',
			profileId: 'profile-1',
			clientAddress: '127.0.0.1'
		});
		expect(JSON.stringify(caller)).not.toContain('mcpgw_');
		await client.close();
	});
});

describe('sessions', () => {
	test('a session is indexed while alive and dropped on DELETE', async () => {
		const { url, sessions } = await serve({ backend: stubBackend() });
		const { client, sessionId } = await connect(url);
		const id = sessionId() as string;
		expect(sessions.count).toBe(1);
		expect(sessions.list()[0]).toMatchObject({ keyName: 'laptop', profileId: 'profile-1' });

		const deleted = await fetch(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': id } });
		expect(deleted.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sessions.get(id)).toBeUndefined();
		expect(sessions.count).toBe(0);

		// a session that was deleted server-side cannot be reused
		const reuse = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				'Mcp-Session-Id': id
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
		});
		expect(reuse.status).toBe(404);
		await client.close().catch(() => undefined);
	});

	test('a request with an unknown session id gets a JSON-RPC 404', async () => {
		const { url } = await serve({ backend: stubBackend() });
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json',
				'Mcp-Session-Id': 'bogus'
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
		});
		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32000);
	});

	test('revoking a key closes its live sessions immediately (FR-03)', async () => {
		const { url, sessions } = await serve({ backend: stubBackend() });
		const { client } = await connect(url);
		expect(sessions.count).toBe(1);
		expect(await sessions.closeForKey('key-1', 'revoked')).toBe(1);
		expect(sessions.count).toBe(0);
		await expect(client.listTools()).rejects.toThrow();
	});

	test('two keys get two independent sessions', async () => {
		const backend = stubBackend({
			listTools: async (caller) => ({
				items: [
					{
						name: `tool_for_${caller.apiKeyId}`,
						inputSchema: { type: 'object' },
						meta: { upstream: caller.apiKeyId, upstreamTool: 'x', health: 'healthy' }
					}
				]
			})
		});
		const { url, sessions } = await serve({
			backend,
			// identity comes from the bearer token, exactly as in production
			authenticate: async (request) => {
				const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
				return {
					...CALLER,
					apiKeyId: token,
					keyName: token,
					requestId: 'r',
					clientAddress: '127.0.0.1'
				};
			}
		});
		const first = await connect(url, { accessToken: 'alice' });
		const second = await connect(url, { accessToken: 'bob' });
		const [a, b] = await Promise.all([first.client.listTools(), second.client.listTools()]);
		expect((a.tools[0] as { name: string }).name).toBe('tool_for_alice');
		expect((b.tools[0] as { name: string }).name).toBe('tool_for_bob');
		expect(sessions.count).toBe(2);
		await first.client.close();
		await second.client.close();
	});
});

describe('tools, resources and prompts', () => {
	test('tools/list carries namespaced names and upstream metadata', async () => {
		const { url } = await serve({ backend: stubBackend() });
		const { client } = await connect(url);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(['github__create_pr', 'sentry__list_events']);
		expect(tools[0]?.description).toBe('Open a pull request');
		expect((tools[0]?._meta as Record<string, unknown>)?.['mcp-gateway']).toEqual({
			upstream: 'github',
			upstreamTool: 'create_pr',
			health: 'healthy'
		});
		await client.close();
	});

	test('tools/call passes arguments through and returns the upstream answer', async () => {
		const backend = stubBackend();
		const { url } = await serve({ backend });
		const { client } = await connect(url);
		const result = await client.callTool({
			name: 'github__create_pr',
			arguments: { title: 'fix: thing' }
		});
		expect(JSON.stringify(result.content)).toContain('opened fix: thing');
		expect(result.isError).toBeFalsy();
		expect(backend.calls).toContain('callTool:github__create_pr');
		await client.close();
	});

	test('an unknown tool is a protocol error (-32602)', async () => {
		const { url } = await serve({ backend: stubBackend() });
		const { client } = await connect(url);
		await expect(client.callTool({ name: 'nope__missing', arguments: {} })).rejects.toThrow(
			/unknown tool|Invalid params|-32602/
		);
		await client.close();
	});

	test('an out-of-scope tool looks exactly like a nonexistent method (-32601)', async () => {
		const { url } = await serve({ backend: stubBackend() });
		const { client } = await connect(url);
		let error: unknown;
		try {
			await client.callTool({ name: 'github__delete_repo', arguments: {} });
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(McpError);
		expect((error as McpError).code).toBe(-32601);
		expect((error as McpError).message).not.toContain('not allowed');
		await client.close();
	});

	test('an unreachable upstream is returned as an isError result, not a protocol error', async () => {
		const { url } = await serve({ backend: stubBackend() });
		const { client } = await connect(url);
		const result = await client.callTool({ name: 'github__boom', arguments: {} });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('connection reset');
		await client.close();
	});

	test('resources, templates and prompts are proxied', async () => {
		const { url } = await serve({ backend: stubBackend() });
		const { client } = await connect(url);
		expect((await client.listResources()).resources[0]?.uri).toBe('github://prs');
		expect((await client.listResourceTemplates()).resourceTemplates[0]?.uriTemplate).toBe(
			'github://repo/{owner}'
		);
		const read = await client.readResource({ uri: 'github://prs' });
		expect(JSON.stringify(read.contents)).toContain('application/json');
		expect((await client.listPrompts()).prompts[0]?.name).toBe('github__review');
		const prompt = await client.getPrompt({ name: 'github__review', arguments: { pr: '42' } });
		expect(JSON.stringify(prompt.messages)).toContain('review 42');
		await client.close();
	});

	test('resources.subscribe is advertised only when the profile supports it', async () => {
		const { url } = await serve({
			backend: stubBackend({ supportsResourceSubscribe: () => true })
		});
		const { client } = await connect(url);
		expect(client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true });
		await client.close();
	});
});

describe('progress and streaming', () => {
	test('upstream progress is forwarded to the calling client', async () => {
		const backend = stubBackend({
			callTool: async (_caller, _name, _args, context) => {
				await context.reportProgress?.({ progress: 1, total: 3, message: 'step 1' });
				await context.reportProgress?.({ progress: 3, total: 3 });
				return { content: [{ type: 'text', text: 'done' }] };
			}
		});
		// progress notifications need a streaming response channel
		const { url } = await serve({ backend, enableJsonResponse: false });
		const { client } = await connect(url);
		const received: number[] = [];
		await client.callTool({ name: 'github__create_pr', arguments: { title: 'slow' } }, undefined, {
			onprogress: (progress) => {
				received.push(progress.progress);
			}
		});
		expect(received).toEqual([1, 3]);
		await client.close();
	});

	test('SSE mode streams the response instead of a single JSON body', async () => {
		const { url } = await serve({ backend: stubBackend(), enableJsonResponse: false });
		const init = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'sse', version: '1' }
				}
			})
		});
		const sessionId = init.headers.get('mcp-session-id');
		expect(sessionId).toBeTruthy();
		await init.body?.cancel();

		const listed = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				'Mcp-Session-Id': sessionId as string
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
		});
		expect(listed.headers.get('content-type')).toContain('text/event-stream');
		const text = await listed.text();
		expect(text).toContain('event: message');
		expect(text).toContain('github__create_pr');
	});
});

describe('auth boundary', () => {
	test('an authentication failure is passed through untouched', async () => {
		const backend = stubBackend();
		const { url } = await serve({
			backend,
			authenticate: async () => ({
				response: new Response(JSON.stringify({ error: 'unauthorized' }), {
					status: 401,
					headers: { 'www-authenticate': 'Bearer realm="mcp"' }
				})
			})
		});
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream'
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'x', version: '1' }
				}
			})
		});
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toContain('Bearer');
		expect(backend.calls).toEqual([]);
	});
});

describe('session registry (unit)', () => {
	test('idle sessions are collected and the live counter follows', async () => {
		const sessions = new SessionRegistry();
		const register = (id: string, seenAt: number) => {
			const session = sessions.register({
				id,
				caller: { ...CALLER, requestId: 'r', clientAddress: '::1' },
				server: { close: async () => undefined } as never,
				transport: { close: async () => undefined } as never,
				unwatch: () => undefined
			});
			(session as unknown as { lastSeenAt: number }).lastSeenAt = seenAt;
			return session;
		};
		register('fresh', Date.now());
		register('stale', Date.now() - 60_000);
		expect(sessions.count).toBe(2);
		expect(await sessions.collectGarbage(30_000)).toEqual(['stale']);
		expect(sessions.count).toBe(1);
		await sessions.closeAll();
		expect(sessions.count).toBe(0);
	});

	test('close on an unknown id is a no-op', async () => {
		const sessions = new SessionRegistry();
		expect(await sessions.close('nope', 'client')).toBe(false);
		expect(await sessions.closeForKey('nope', 'revoked')).toBe(0);
	});
});
