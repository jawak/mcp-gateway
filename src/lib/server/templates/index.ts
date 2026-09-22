/**
 * Template catalogue (T-45).
 *
 * A template is a starting point, not a package manager: it never downloads or
 * executes anything, and it never contains a token. Installing one creates an
 * upstream with a *secret reference* whose value the operator fills in, so the
 * same rule that protects hand-written configuration (BR-09) also protects the
 * easy path.
 *
 * The catalogue is bundled so an air-gapped install works, and an operator can
 * point MCPGW_TEMPLATE_CATALOG_URL at their own file to add internal servers.
 */
import { z } from 'zod';
import { secretRef } from '../security/env-resolve.ts';

export const templateFieldSchema = z.object({
	/** Environment variable the value is handed to. */
	env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
	label: z.string().min(1),
	help: z.string().min(1),
	/** Secrets are sealed; plain fields are stored as literals. */
	secret: z.boolean().default(true),
	required: z.boolean().default(true),
	/**
	 * Where a non-secret answer goes, because the servers disagree about it:
	 * `server-filesystem` and `server-sqlite` take their target as a positional
	 * argument, while `server-github` and `server-slack` read extra settings from
	 * the environment. Guessing wrong is invisible until the child misbehaves, so
	 * each template declares it instead of relying on a rule that cannot hold.
	 */
	placement: z.enum(['arg', 'env']).default('arg')
});

export const templateSchema = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
	name: z.string().min(1),
	description: z.string().min(1),
	transport: z.enum(['stdio', 'http']),
	command: z.string().min(1).optional(),
	args: z.array(z.string()).default([]),
	url: z.string().url().optional(),
	authStyle: z.enum(['bearer', 'header', 'none']).default('none'),
	fields: z.array(templateFieldSchema).default([]),
	docsUrl: z.string().url().optional(),
	tags: z.array(z.string()).default([])
});

export type Template = z.infer<typeof templateSchema>;

export const templateListSchema = z.array(templateSchema);

/**
 * Bundled catalogue. Everything here is `npx`, because these are the servers whose
 * packaging is stable enough to name. `command` is an unrestricted string in the schema
 * and in the database, so a Python (`uvx`), Deno or absolute-path server is a normal
 * upstream — it simply has no entry in this list, and the runtime has to exist on the
 * gateway host rather than being the gateway's business.
 */
export const BUNDLED_TEMPLATES: Template[] = templateListSchema.parse([
	{
		id: 'github',
		name: 'GitHub',
		description: 'Issues, pull requests, workflow runs and code search.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-github'],
		fields: [
			{
				env: 'GITHUB_PERSONAL_ACCESS_TOKEN',
				label: 'GitHub token',
				help: 'Classic PAT with repo and read:org scopes.',
				secret: true
			},
			{
				env: 'GITHUB_OWNER',
				label: 'Default owner (optional)',
				help: 'Pre-fills the owner for tools that accept it.',
				secret: false,
				required: false,
				placement: 'env'
			}
		],
		docsUrl: 'https://github.com/github/github-mcp-server',
		tags: ['source-control', 'ci']
	},
	{
		id: 'sentry',
		name: 'Sentry',
		description: 'Errors, issues and release context from Sentry.',
		transport: 'http',
		url: 'https://mcp.sentry.dev/mcp',
		authStyle: 'bearer',
		fields: [
			{
				env: 'SENTRY_TOKEN',
				label: 'Sentry token',
				help: 'Used as the bearer token for the remote endpoint.',
				secret: true
			}
		],
		docsUrl: 'https://mcp.sentry.dev',
		tags: ['observability']
	},
	{
		id: 'postgres',
		name: 'PostgreSQL',
		description: 'Read-only query access to a database (point it at a replica).',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-postgres'],
		fields: [
			{
				env: 'DATABASE_URL',
				label: 'Connection string',
				help: 'Use a read-only role and a replica if you can.',
				secret: true
			}
		],
		tags: ['database']
	},
	{
		id: 'filesystem',
		name: 'Filesystem',
		description: 'Scoped file access to one or more directories on this host.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-filesystem'],
		fields: [
			{
				env: 'ALLOWED_DIR',
				label: 'Allowed directory',
				help: 'Absolute path. The server is restricted to this subtree.',
				secret: false
			}
		],
		tags: ['files']
	},
	{
		id: 'playwright',
		name: 'Playwright',
		description: 'Drive a real browser: navigate, click, screenshot.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@playwright/mcp'],
		fields: [],
		docsUrl: 'https://github.com/microsoft/playwright-mcp',
		tags: ['browser', 'testing']
	},
	{
		id: 'linear',
		name: 'Linear',
		description: 'Issues, projects and cycles.',
		transport: 'http',
		url: 'https://mcp.linear.app/mcp',
		authStyle: 'bearer',
		fields: [
			{
				env: 'LINEAR_TOKEN',
				label: 'Linear API key',
				help: 'Created in Linear settings → API keys.',
				secret: true
			}
		],
		tags: ['issues']
	},
	{
		id: 'slack',
		name: 'Slack',
		description: 'Channels, messages and search.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-slack'],
		fields: [
			{
				env: 'SLACK_BOT_TOKEN',
				label: 'Bot token',
				help: 'xoxb-… with channels:read and history:read.',
				secret: true
			},
			{
				env: 'SLACK_TEAM_ID',
				label: 'Team ID',
				help: 'Found in your workspace URL.',
				secret: false,
				placement: 'env'
			}
		],
		tags: ['chat']
	},
	{
		id: 'notion',
		name: 'Notion',
		description: 'Pages, databases and search.',
		transport: 'http',
		url: 'https://mcp.notion.com/mcp',
		authStyle: 'bearer',
		fields: [
			{
				env: 'NOTION_TOKEN',
				label: 'Notion integration token',
				help: 'secret token from an internal integration.',
				secret: true
			}
		],
		tags: ['docs']
	},
	{
		id: 'gitlab',
		name: 'GitLab',
		description: 'Merge requests, pipelines and repository content.',
		transport: 'http',
		url: 'https://gitlab.com/api/v4/mcp',
		authStyle: 'bearer',
		fields: [
			{
				env: 'GITLAB_TOKEN',
				label: 'GitLab access token',
				help: 'glpat-… with api scope.',
				secret: true
			}
		],
		tags: ['source-control']
	},
	{
		id: 'memory',
		name: 'Knowledge graph memory',
		description: 'Persistent memory across sessions, running on this host.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-memory'],
		fields: [],
		tags: ['memory', 'local']
	},
	{
		id: 'sqlite',
		name: 'SQLite',
		description: 'Query a local SQLite database.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-sqlite'],
		fields: [
			{
				env: 'SQLITE_PATH',
				label: 'Database path',
				help: 'Absolute path to the .db file.',
				secret: false
			}
		],
		tags: ['database', 'local']
	},
	{
		id: 'puppeteer',
		name: 'Puppeteer',
		description: 'Browser automation with screenshots and PDF export.',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-puppeteer'],
		fields: [],
		tags: ['browser']
	}
]);

/** Templates sorted for display; ids stay stable for deep links. */
export function listTemplates(): Template[] {
	return [...BUNDLED_TEMPLATES].sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplate(id: string): Template | undefined {
	return BUNDLED_TEMPLATES.find((template) => template.id === id);
}

export type InstallPlan = {
	slug: string;
	name: string;
	transport: 'stdio' | 'http';
	connection: Record<string, unknown>;
	envRefs: Record<string, string>;
	headersRef?: string;
};

/**
 * Turn a template plus the operator's answers into an upstream definition.
 *
 * This is the ONLY place that turns template answers into an upstream: the gallery
 * install and the "start from a template" form both come through here. Having two
 * copies is how one of them ended up writing a bare secret name (which resolves as a
 * literal, so the child received the secret's *name* instead of its value) while the
 * other wrote the correct reference.
 *
 * Secret answers become sealed values plus a `secret:<slug>__<ENV>` reference in the
 * upstream definition, which is why the exported manifest for an installed template
 * still contains no credentials (BR-09).
 */
export function planInstall(
	template: Template,
	answers: Record<string, string>,
	rawSlug: string
): { plan: InstallPlan; secrets: Array<{ name: string; value: string }>; missing: string[] } {
	// normalised here so every caller agrees on the slug, the secret names derived
	// from it, and therefore which reference resolves
	const slug = rawSlug.trim().toLowerCase();
	const envRefs: Record<string, string> = {};
	const args = [...template.args];
	const secrets: Array<{ name: string; value: string }> = [];
	const missing: string[] = [];

	for (const field of template.fields) {
		const value = (answers[field.env] ?? '').trim();
		if (!value) {
			if (field.required) missing.push(field.label);
			continue;
		}
		if (field.secret) {
			const secretName = `${slug}__${field.env.toLowerCase()}`
				.toLowerCase()
				.replace(/[^a-z0-9_-]/g, '-');
			secrets.push({ name: secretName, value });
			// must be a `secret:` reference: without the prefix `parseRef` classifies
			// it as a literal and the upstream is handed the secret's name as its value
			envRefs[field.env] = secretRef(secretName);
		} else if (field.placement === 'env') {
			// literal non-secret configuration (an owner or team id), stored as the
			// value itself — a `${VAR}` reference here would demand a variable on the
			// gateway host that the operator already typed into the form
			envRefs[field.env] = value;
		} else {
			// a positional argument, exactly as the CLI expects it, and nothing else
			args.push(value);
		}
	}

	const connection: Record<string, unknown> =
		template.transport === 'stdio'
			? { command: template.command ?? 'npx', args }
			: {
					url: template.url,
					authStyle: template.authStyle === 'none' ? 'none' : template.authStyle
				};

	return {
		plan: {
			slug,
			name: template.name,
			transport: template.transport,
			connection,
			envRefs,
			...(template.authStyle === 'header' ? { headersRef: `${slug}__headers` } : {})
		},
		secrets,
		missing
	};
}
