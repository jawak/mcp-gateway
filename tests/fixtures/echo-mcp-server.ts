/**
 * Test fixture: the shared MCP surface served over stdio.
 *
 * Run manually while developing:
 *   npx @modelcontextprotocol/inspector --cli bun tests/fixtures/echo-mcp-server.ts --method tools/list
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerFixtureTools } from './register-tools.js';

// FIXTURE_STDERR=1 → write noise (incl. a token) to stderr before connecting, to
// exercise the gateway's stderr capture + redaction.
if (process.env.FIXTURE_STDERR) {
	console.error(
		'[fixture] startup notice: listening soon, rotation token ghp_ShouldNotLeak00000000'
	);
	console.error('[fixture] second line for the tail buffer');
}

const server = new McpServer(
	{ name: 'fixture-upstream', version: '1.0.0' },
	{ capabilities: { logging: {} } }
);
registerFixtureTools(server);

await server.connect(new StdioServerTransport());
