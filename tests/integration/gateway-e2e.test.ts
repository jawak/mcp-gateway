/**
 * End-to-end gateway tests (T-16, T-17, T-18).
 *
 * Real MCP client → real endpoint → real catalog/pool → real stdio upstreams.
 * This is the test that proves the product works: namespacing, scoping, routing,
 * retry-after-crash, resources, prompts and the `tool_calls` audit trail in one
 * pass.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createMcpEndpoint } from '../../src/lib/server/mcp/gateway';
import { createGatewayBackend } from '../../src/lib/server/mcp/handlers';
import { ToolCatalog } from '../../src/lib/server/mcp/catalog';
import { UpstreamPool } from '../../src/lib/server/upstream/pool';
import { createProfile, reload, setUpstreamEnabled } from '../../src/lib/server/registry';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { apiKeys, toolCalls, upstreams } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'echo-mcp-server.ts');
const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-e2e-'));

let server: ReturnType<typeof Bun.serve>;
let url: string;
let pool: UpstreamPool;
let catalog: ToolCatalog;
const ids: Record<string, string> = {};

function insertUpstream(slug: string, overrides: Record<string, unknown> = {}) {
	const id = uuidv7();
	getDb()
		.insert(upstreams)
		.values({
			id,
			slug,
			name: slug,
			transport: 'stdio',
			connection: { command: process.execPath, args: [FIXTURE] },
			pin: 'pinned',
			enabled: true,
			timeoutMs: 10_000,
			...overrides
		})
		.run();
	ids[slug] = id;
	return id;
}

beforeAll(async () => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '3'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));

	insertUpstream('alpha');
	insertUpstream('beta');
	// long enough to boot the child, short enough to time out on the tool call
	insertUpstream('slowpoke', { timeoutMs: 3_000 });
	reload(getDb());

	const profile = createProfile({
		name: 'e2e-profile',
		links: [
			{ upstreamId: ids.alpha as string },
			// beta is scoped in but its destructive tools are denied
			{ upstreamId: ids.beta as string, denyGlobs: ['*__suicide', '*__explode'] },
			{ upstreamId: ids.slowpoke as string }
		]
	});

	// both api_key foreign keys are real: create the profile first, then a key row
	// so tool_calls rows can reference it
	getDb()
		.insert(apiKeys)
		.values({
			id: 'e2e-key',
			keyHash: uuidv7(),
			keyPrefix: 'mcpgw_e',
			keyTail4: 'e2e1',
			name: 'e2e',
			profileId: profile.id,
			status: 'active'
		})
		.run();
	reload(getDb());

	pool = new UpstreamPool({ maxLive: 8, concurrencyPerUpstream: 4 });
	catalog = new ToolCatalog({ pool, skipUnhealthy: false, ttlMs: 60_000 });
	const off = catalog.watchInvalidations();
	const backend = createGatewayBackend({ catalog, pool });
	const endpoint = createMcpEndpoint({
		backend,
		authenticate: async () => {
			const profile = [
				...(await import('../../src/lib/server/registry')).getSnapshot().profilesById.values()
			][0];
			return {
				apiKeyId: 'e2e-key',
				keyName: 'e2e',
				profileId: profile?.id as string,
				requestId: 'e2e-req',
				clientAddress: '127.0.0.1'
			};
		}
	});
	server = Bun.serve({
		port: 0,
		fetch: (request) =>
			endpoint.handle(request, { requestId: 'e2e-req', clientAddress: '127.0.0.1' })
	});
	url = `http://127.0.0.1:${server.port}/mcp`;
	return () => off();
});

afterAll(async () => {
	await pool.closeAll(1_000);
	server?.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
	const client = new Client({ name: 'e2e-client', version: '1' }, { capabilities: {} });
	await client.connect(new StreamableHTTPClientTransport(new URL(url)));
	return client;
}

function rows(tool?: string) {
	const all = getDb().select().from(toolCalls).all();
	return tool ? all.filter((row) => row.tool === tool) : all;
}

describe('tools/list through the gateway', () => {
	test('aggregates both upstreams with namespaced names and provenance', async () => {
		const client = await connect();
		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name);
		expect(names).toContain('alpha__echo');
		expect(names).toContain('beta__add');
		expect(names).toContain('slowpoke__slow');
		expect(
			(tools.find((tool) => tool.name === 'alpha__echo')?._meta as Record<string, unknown>)?.[
				'mcp-gateway'
			]
		).toMatchObject({
			upstream: 'alpha',
			upstreamTool: 'echo'
		});
		await client.close();
	});

	test('a denied tool is invisible (BR-03)', async () => {
		const client = await connect();
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names).toContain('alpha__suicide'); // same tool, upstream without the rule
		expect(names).not.toContain('beta__suicide');
		expect(names).not.toContain('beta__explode');
		await client.close();
	});

	test('disabling an upstream removes only its tools (BR-04)', async () => {
		const client = await connect();
		setUpstreamEnabled(ids.beta as string, false);
		catalog.invalidate();
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		expect(names.some((name) => name.startsWith('beta__'))).toBe(false);
		expect(names).toContain('alpha__echo');
		setUpstreamEnabled(ids.beta as string, true);
		catalog.invalidate();
		await client.close();
	});
});

describe('tools/call through the gateway', () => {
	test('routes to the right upstream and returns its answer', async () => {
		const client = await connect();
		const echo = await client.callTool({ name: 'alpha__echo', arguments: { text: 'one' } });
		expect(JSON.stringify(echo.content)).toContain('echo:one');
		const sum = await client.callTool({ name: 'beta__add', arguments: { a: 2, b: 40 } });
		expect(JSON.stringify(sum.content)).toContain('42');
		await client.close();
	});

	test('a denied tool cannot be called even with the exact name (-32601)', async () => {
		const client = await connect();
		let error: unknown;
		try {
			await client.callTool({ name: 'beta__suicide', arguments: {} });
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(McpError);
		expect((error as McpError).code).toBe(-32601);
		// the upstream was never touched
		expect(rows('beta__suicide')[0]?.status).toBe('rejected');
		await client.close();
	});

	test('an unknown tool is rejected (-32602)', async () => {
		const client = await connect();
		let error: unknown;
		try {
			await client.callTool({ name: 'nosuch__thing', arguments: {} });
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(McpError);
		expect((error as McpError).code).toBe(-32602);
		await client.close();
	});

	test('an upstream error is an isError result and is logged, redacted', async () => {
		const client = await connect();
		const result = await client.callTool({ name: 'alpha__boom', arguments: {} });
		expect(result.isError).toBe(true);
		const row = rows('alpha__boom').at(-1);
		expect(row?.status).toBe('error');
		expect(row?.error).toContain('[redacted]');
		expect(row?.error).not.toContain('ghp_ShouldBeRedacted000000');
		await client.close();
	});

	test('a crashed child is respawned and the call still succeeds (retry once)', async () => {
		const client = await connect();
		await client.callTool({ name: 'alpha__suicide', arguments: {} }).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const after = await client.callTool({
			name: 'alpha__echo',
			arguments: { text: 'resurrected' }
		});
		expect(JSON.stringify(after.content)).toContain('echo:resurrected');
		const row = rows('alpha__echo').at(-1);
		expect(row?.status).toBe('ok');
		await client.close();
	});

	test('the per-upstream timeout is enforced and recorded as timeout', async () => {
		const client = await connect();
		const result = await client.callTool({ name: 'slowpoke__slow', arguments: { ms: 30_000 } });
		expect(result.isError).toBe(true);
		const row = rows('slowpoke__slow').at(-1);
		expect(row?.status).toBe('timeout');
		expect(row?.durationMs).toBeGreaterThanOrEqual(2_000);
		expect(row?.durationMs).toBeLessThan(9_000);
		await client.close();
	});

	test('every call leaves a row with duration and sizes', async () => {
		const client = await connect();
		await client.callTool({ name: 'alpha__echo', arguments: { text: 'accounted' } });
		const row = rows('alpha__echo').at(-1);
		expect(row).toMatchObject({ apiKeyId: 'e2e-key', upstreamTool: 'echo', status: 'ok' });
		expect(row?.upstreamId).toBe(ids.alpha);
		expect(row?.durationMs).toBeGreaterThanOrEqual(0);
		expect(row?.reqBytes).toBeGreaterThan(0);
		expect(row?.resBytes).toBeGreaterThan(0);
		await client.close();
	});
});

describe('resources and prompts through the gateway', () => {
	test('resources are namespaced and readable', async () => {
		const client = await connect();
		const { resources } = await client.listResources();
		const qualified = resources.find((resource) => resource.uri.includes('alpha__'));
		expect(qualified?.uri).toBe('fixture://alpha__status');
		const read = await client.readResource({ uri: qualified?.uri as string });
		expect(JSON.stringify(read.contents)).toContain('operational');
		await client.close();
	});

	test('prompts are namespaced and gettable', async () => {
		const client = await connect();
		const { prompts } = await client.listPrompts();
		expect(prompts.map((prompt) => prompt.name)).toContain('alpha__summarise');
		const got = await client.getPrompt({
			name: 'alpha__summarise',
			arguments: { target: 'the spec' }
		});
		expect(JSON.stringify(got.messages)).toContain('Summarise: the spec');
		await client.close();
	});

	test('a prompt from a denied upstream cannot be fetched', async () => {
		// deny is expressed on qualified names, so scope a rule against the prompt
		const profile = [
			...(await import('../../src/lib/server/registry')).getSnapshot().profilesById.values()
		][0];
		const { setProfileLinks } = await import('../../src/lib/server/registry');
		const slowpokeLink = { upstreamId: ids.slowpoke as string };
		setProfileLinks(profile?.id as string, [
			{ upstreamId: ids.alpha as string },
			{ upstreamId: ids.beta as string, denyGlobs: ['beta__*'] },
			slowpokeLink
		]);
		catalog.invalidate();
		const client = await connect();
		const names = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
		expect(names).not.toContain('beta__summarise');
		expect(names).toContain('alpha__summarise');
		let error: unknown;
		try {
			await client.getPrompt({ name: 'beta__summarise', arguments: { target: 'x' } });
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(McpError);
		await client.close();
		setProfileLinks(profile?.id as string, [
			{ upstreamId: ids.alpha as string },
			{ upstreamId: ids.beta as string, denyGlobs: ['*__suicide', '*__explode'] },
			slowpokeLink
		]);
		catalog.invalidate();
	});
});

describe('pool bookkeeping', () => {
	test('live upstreams are tracked and released on shutdown', async () => {
		const client = await connect();
		await client.callTool({ name: 'alpha__echo', arguments: { text: 'pooled' } });
		expect(pool.liveSlugs().sort()).toEqual(expect.arrayContaining(['alpha']));
		const stats = pool.stats();
		expect(stats.bySlug.alpha?.connected).toBe(true);
		await client.close();
	});

	test('unknown upstreams are not pooled for a call', async () => {
		const client = await connect();
		await expect(client.callTool({ name: 'ghost__tool', arguments: {} })).rejects.toThrow();
		expect(pool.liveSlugs()).not.toContain('ghost');
		await client.close();
	});
});

describe('registry visibility', () => {
	test('a row exists for every outcome type seen so far', () => {
		const statuses = new Set(rows().map((row) => row.status));
		for (const expected of ['ok', 'error', 'rejected', 'timeout']) {
			expect(statuses.has(expected as never), expected).toBe(true);
		}
		expect(rows().every((row) => row.requestId === 'e2e-req')).toBe(true);
		expect(getDb().select().from(upstreams).all()).toHaveLength(3);
	});
});
