/**
 * Helpers for driving the admin console from scripts (T-42, T-44).
 *
 * These scripts deliberately go through the same form actions a browser uses
 * rather than poking the database: that is what makes them useful as a release
 * gate — they fail when the wiring, not just the logic, is broken.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type Console = {
	base: string;
	signIn: () => Promise<void>;
	createUpstream: (input: { slug: string; name: string; command: string; args: string }) => Promise<{ ok: boolean; location: string }>;
	createProfile: (input: { name: string; slug: string; rateLimitRpm?: number; dailyCallQuota?: number }) => Promise<string>;
	createKey: (input: { name: string; profileId: string }) => Promise<string>;
	mcpClient: (apiKey: string) => Promise<{ client: Client; close: () => Promise<void> }>;
	get: (path: string) => Promise<{ status: number; body: string }>;
	signedIn: () => boolean;
	cookieHeader: () => string;
};

/** Cookie jar good enough for a login round trip. */
function jar() {
	const cookies = new Map<string, string>();
	return {
		header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
		absorb(response: Response) {
			for (const raw of response.headers.getSetCookie()) {
				const [pair] = raw.split(';');
				if (!pair) continue;
				const index = pair.indexOf('=');
				if (index < 0) continue;
				cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
			}
		}
	};
}

export function createConsole(options: { base: string; email: string; password: string }): Console {
	const base = options.base.replace(/\/$/, '');
	const cookies = jar();
	let signedIn = false;

	const browser = async (path: string, init: RequestInit = {}): Promise<Response> => {
		const response = await fetch(`${base}${path}`, {
			...init,
			redirect: 'manual',
			headers: {
				origin: base,
				accept: 'text/html,application/xhtml+xml',
				...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
				...(cookies.header() ? { cookie: cookies.header() } : {})
			}
		});
		cookies.absorb(response);
		return response;
	};

	const form = (fields: Record<string, string>) =>
		({ method: 'POST', body: new URLSearchParams(fields).toString() }) as RequestInit;

	return {
		base,
		signedIn: () => signedIn,
		cookieHeader: () => cookies.header(),

		async signIn() {
			const response = await browser('/login?/login', form({ email: options.email, password: options.password, next: '/admin' }));
			if (response.status !== 303) throw new Error(`sign-in failed with ${response.status}`);
			signedIn = true;
		},

		async createUpstream({ slug, name, command, args }) {
			const response = await browser(
				'/admin/upstreams/new?/create',
				form({
					slug,
					name,
					transport: 'stdio',
					command,
					args,
					pin: 'pinned',
					timeoutMs: '30000',
					allowAnyIp: 'on'
				})
			);
			return { ok: (response.headers.get('location') ?? '').includes('healthy=1'), location: response.headers.get('location') ?? '' };
		},

		async createProfile({ name, slug, rateLimitRpm = 120, dailyCallQuota = 1000 }) {
			const response = await browser(
				'/admin/profiles?/create',
				form({
					name,
					upstream: slug,
					rateLimitRpm: String(rateLimitRpm),
					dailyCallQuota: String(dailyCallQuota),
					maxConcurrency: '20'
				})
			);
			return (response.headers.get('location') ?? '').split('/').pop() ?? '';
		},

		async createKey({ name, profileId }) {
			const response = await browser('/admin/keys/new', form({ name, profileId, validityDays: '1', allowAnyIp: 'on' }));
			const html = await response.text();
			return /mcpgw_[A-Za-z0-9]{30,}/.exec(html)?.[0] ?? '';
		},

		async mcpClient(apiKey) {
			const client = new Client({ name: 'script-client', version: '1.0.0' }, { capabilities: {} });
			const transport = new StreamableHTTPClientTransport(new URL('/mcp', base).toString(), {
				requestInit: { headers: { authorization: `Bearer ${apiKey}` } }
			});
			await client.connect(transport);
			return { client, close: () => client.close() };
		},

		async get(path) {
			const response = await browser(path);
			return { status: response.status, body: await response.text() };
		}
	};
}
