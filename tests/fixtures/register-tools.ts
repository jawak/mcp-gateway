/**
 * Shared tool/resource/prompt registration for the test fixtures.
 *
 * Both the stdio fixture (`echo-mcp-server.ts`) and the HTTP fixture
 * (`http-mcp-server.ts`) register the exact same surface, so transport-specific
 * tests can assert identical behaviour. See `echo-mcp-server.ts` for what each
 * tool is there to exercise.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const PROBE_KEYS = ['PATH', 'HOME', 'NODE_ENV'];
const LEAK_KEYS = [
	'MCPGW_MASTER_KEY',
	'MCPGW_COOKIE_SECRET',
	'MCPGW_ADMIN_PASSWORD',
	'MCPGW_METRICS_TOKEN'
];

export function registerFixtureTools(server: McpServer): void {
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
		async ({ ms }) => {
			// A plain sleep: in stateless HTTP mode the request signal can already be
			// settled, so cancellation is exercised by `slow_watchdog` instead.
			await new Promise((resolve) => setTimeout(resolve, ms));
			return { content: [{ type: 'text', text: `slept:${ms}` }] };
		}
	);

	server.registerTool(
		'slow_watchdog',
		{
			title: 'Slow tool with cancellation',
			description: 'Sleeps but rejects if the caller cancels; used for gateway cancellation tests.',
			inputSchema: { ms: z.number().int().min(0).max(120_000) }
		},
		async ({ ms }, extra) => {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, ms);
				extra.signal?.addEventListener?.('abort', () => {
					clearTimeout(timer);
					reject(new Error('aborted by caller'));
				});
			});
			return { content: [{ type: 'text', text: `watchdog:${ms}` }] };
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
			description: 'Throws inside the handler; the MCP server converts it to an isError result.',
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
			messages: [{ role: 'user', content: { type: 'text', text: `Summarise: ${target}` } }]
		})
	);
}
