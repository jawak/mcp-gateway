/**
 * Test fixture: a real MCP server over stdio.
 *
 * Deliberately covers every behaviour the gateway has to survive:
 *   echo       — happy path round trip
 *   add        — numeric args, schema validation on the upstream side
 *   env_probe  — proves the gateway did not leak MCPGW_MASTER_KEY into the child
 *   slow       — sleeps, used to assert gateway-side timeouts and graceful close
 *   boom       — returns isError:true (an MCP-level error, NOT a transport error)
 *   explode    — throws inside the handler (transport error → retry path)
 *   suicide    — kills the process (crash detection + restart backoff)
 *   huge       — returns a large payload (size limits)
 * plus one resource and one prompt so the resources/prompts proxies have content.
 *
 * Run directly with `bun tests/fixtures/echo-mcp-server.ts` for manual poking:
 *   npx @modelcontextprotocol/inspector --cli bun tests/fixtures/echo-mcp-server.ts --method tools/list
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// FIXTURE_STDERR=1 → write noise (incl. a token) to stderr before connecting, to
// exercise the gateway's stderr capture + redaction.
if (process.env.FIXTURE_STDERR) {
	console.error(
		`[fixture] startup notice: listening soon, rotation token ghp_ShouldNotLeak00000000`
	);
	console.error('[fixture] second line for the tail buffer');
}

const PROBE_KEYS = ['PATH', 'HOME', 'NODE_ENV'];
const LEAK_KEYS = [
	'MCPGW_MASTER_KEY',
	'MCPGW_COOKIE_SECRET',
	'MCPGW_ADMIN_PASSWORD',
	'MCPGW_METRICS_TOKEN'
];

const server = new McpServer(
	{ name: 'fixture-upstream', version: '1.0.0' },
	{ capabilities: { logging: {} } }
);

server.registerTool(
	'echo',
	{
		title: 'Echo',
		description: 'Return the given text back, prefixed with the upstream name.',
		inputSchema: { text: z.string().describe('text to echo back') }
	},
	async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] })
);

server.registerTool(
	'add',
	{
		title: 'Add',
		description: 'Add two integers.',
		inputSchema: { a: z.number().int(), b: z.number().int() }
	},
	async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
);

server.registerTool(
	'env_probe',
	{
		title: 'Environment probe',
		description: 'Report which environment variables are visible to this process.',
		inputSchema: {}
	},
	async () => {
		const present = (names: string[]): string[] =>
			names.filter((name) => process.env[name] !== undefined);
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify({
						present: present(PROBE_KEYS),
						leaked: present(LEAK_KEYS),
						// non-secret values we are allowed to echo, used by assertions
						nodeEnv: process.env.NODE_ENV ?? null,
						marker: process.env.FIXTURE_MARKER ?? null,
						totalKeys: Object.keys(process.env).length
					})
				}
			]
		};
	}
);

server.registerTool(
	'slow',
	{
		title: 'Slow tool',
		description: 'Wait for the given number of milliseconds before answering.',
		inputSchema: { ms: z.number().int().min(0).max(120_000) }
	},
	async ({ ms }, extra) => {
		const signal = extra.signal;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener?.('abort', () => {
				clearTimeout(timer);
				reject(new Error('aborted by caller'));
			});
		});
		return { content: [{ type: 'text', text: `slept:${ms}` }] };
	}
);

server.registerTool(
	'boom',
	{
		title: 'Business error',
		description: 'Always answers with isError:true (an MCP error, not a crash).',
		inputSchema: {}
	},
	async () => ({
		isError: true,
		content: [
			{
				type: 'text',
				text: 'upstream said no: quota exceeded for token ghp_ShouldBeRedacted000000'
			}
		]
	})
);

server.registerTool(
	'explode',
	{
		title: 'Handler crash',
		description: 'Throws inside the handler, simulating a transport-level failure.',
		inputSchema: {}
	},
	async () => {
		throw new Error('handler exploded');
	}
);

server.registerTool(
	'suicide',
	{
		title: 'Kill the server',
		description: 'Terminates this process, simulating an upstream crash.',
		inputSchema: {}
	},
	async () => {
		setTimeout(() => process.exit(7), 10);
		return { content: [{ type: 'text', text: 'bye' }] };
	}
);

server.registerTool(
	'huge',
	{
		title: 'Large payload',
		description: 'Returns roughly `kb` kilobytes of text.',
		inputSchema: { kb: z.number().int().min(1).max(4096) }
	},
	async ({ kb }) => ({ content: [{ type: 'text', text: 'x'.repeat(kb * 1024) }] })
);

server.registerResource(
	'status',
	'fixture://status',
	{ title: 'Status', description: 'Static status document' },
	async (uri) => ({
		contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'fixture-upstream: operational' }]
	})
);

server.registerPrompt(
	'summarise',
	{
		title: 'Summarise',
		description: 'Prompt template for summarising text',
		argsSchema: { target: z.string() }
	},
	async ({ target }) => ({
		messages: [
			{
				role: 'user',
				content: { type: 'text', text: `Summarise: ${target}` }
			}
		]
	})
);

await server.connect(new StdioServerTransport());
