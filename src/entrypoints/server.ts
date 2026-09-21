/**
 * Production entrypoint (T-02).
 *
 * Boots SvelteKit's `Server` (the same class `@sveltejs/adapter-node` drives)
 * plus the gateway-owned endpoints behind a single `node:http` listener, so the
 * MCP endpoint and the admin dashboard share one origin (no CORS, one TLS term).
 *
 * `Server`, the generated manifest and the client assets are resolved at
 * runtime: they only exist after `vite build`, and the manifest is pure data so
 * it can be imported directly (the adapter's `handler.js` does the same via its
 * `SERVER`/`MANIFEST` aliases).
 *
 * Build order: `vite build` → `bun run build:server` → `build/server.js`.
 * Runtime therefore needs both `.svelte-kit/output/` and `build/` present.
 */
import http from 'node:http';
import path from 'node:path';
import { createFetchHandler } from '../handle.ts';
import { createGatewayApp } from '../lib/server/gateway-app.ts';
import { createMcpAuthenticator } from '../middleware/auth.ts';
import {
	PayloadTooLargeError,
	toWebRequest,
	writePlainError,
	writeWebResponse
} from '../lib/server/http/bridge.ts';
import { serveStatic } from '../lib/server/http/static.ts';
import { runMigrations } from '../lib/server/db/migrate.ts';
import { seedAdmin } from '../lib/server/db/seed.ts';
import { events } from '../lib/server/registry/events.ts';
import { ConfigError, getConfig, type Config } from '../lib/server/config.ts';
import { logger } from '../lib/server/observability/logger.ts';

const log = logger.child({ component: 'server' });

/** Fail fast: a misconfigured gateway must not start half-alive. */
let config: Config;
try {
	config = getConfig();
} catch (error) {
	if (error instanceof ConfigError) {
		console.error(error.message);
		process.exit(1);
	}
	throw error;
}
if (config.masterKeyIsEphemeral) {
	log.warn('secrets sealed in this process will not survive a restart (MCPGW_MASTER_KEY unset)');
}

type SvelteKitServer = {
	init: (opts: {
		env: Record<string, string>;
		read?: (file: string) => ReadableStream | Blob;
	}) => Promise<void>;
	respond: (
		request: Request,
		options: { getClientAddress: () => string; platform?: { req: unknown } }
	) => Promise<Response>;
};

/** Project root: repo root in dev, image root in Docker (bundled to build/server.js). */
function resolveRoot(): string {
	if (process.env.MCPGW_ROOT_DIR) return path.resolve(process.env.MCPGW_ROOT_DIR);
	const here = path.dirname(new URL(import.meta.url).pathname);
	return path.basename(here) === 'build' ? path.dirname(here) : path.resolve(here, '../..');
}

async function loadSvelteKit(root: string): Promise<SvelteKitServer> {
	const out = path.join(root, '.svelte-kit', 'output', 'server');
	const serverEntry = path.join(out, 'index.js');
	const manifestEntry = path.join(out, 'manifest.js');
	for (const file of [serverEntry, manifestEntry]) {
		if (!(await Bun.file(file).exists())) {
			throw new Error(`missing build artifact ${file} — run \`bun run build\` first`);
		}
	}
	const [{ Server }, { manifest }] = await Promise.all([
		import(serverEntry) as Promise<{ Server: new (manifest: never) => SvelteKitServer }>,
		import(manifestEntry) as Promise<{ manifest: never }>
	]);
	return new Server(manifest);
}

async function createApp(): Promise<() => Promise<void>> {
	// Single-writer migration at boot, before a single request is served.
	const { db, version } = runMigrations();
	log.info({ schema_version: version }, 'database migrated');
	const seeded = await seedAdmin(db);
	if (seeded.created)
		log.info({ email: seeded.email, reason: seeded.reason }, 'admin bootstrapped');

	const root = resolveRoot();
	const clientDir = path.join(root, 'build', 'client');
	const app = await loadSvelteKit(root);

	await app.init({
		env: process.env as Record<string, string>,
		read: (file) => Bun.file(path.join(clientDir, file)) as unknown as ReadableStream
	});
	log.info({ root, version: config.version }, 'sveltekit server initialised');

	const gateway = createGatewayApp({ authenticate: createMcpAuthenticator() });
	const handleFetch = createFetchHandler({
		mcp: (request, context) => gateway.endpoint.handle(request, context),
		sveltekit: async (request, context) => {
			const staticResponse = await serveStatic(request, { root: clientDir });
			if (staticResponse) return staticResponse;
			return app.respond(request, { getClientAddress: () => context.clientAddress });
		},
		version: config.version,
		maxBodyBytes: config.maxBodyBytes
	});

	const server = http.createServer(async (req, res) => {
		try {
			const request = await toWebRequest(req, {
				trustProxy: config.trustProxy,
				maxBodyBytes: config.maxBodyBytes
			});
			await writeWebResponse(await handleFetch(request), res);
		} catch (error) {
			if (error instanceof PayloadTooLargeError) {
				writePlainError(res, 413, `payload too large (limit ${error.limitBytes} bytes)`);
				return;
			}
			logger.error({ err: error, path: req.url }, 'unhandled request error');
			writePlainError(res, 500, 'internal server error');
		}
	});

	let closing = false;
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		events.emit('shutdown', { reason: 'SIGTERM' });
		await new Promise<void>((resolve) => {
			const hardStop = setTimeout(() => {
				logger.warn('shutdown timeout reached, closing remaining connections');
				server.closeAllConnections();
				resolve();
			}, config.gracefulShutdownMs);
			server.closeIdleConnections();
			server.close(() => {
				clearTimeout(hardStop);
				resolve();
			});
		});
	};

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			log.info({ signal }, 'shutting down');
			void close().then(() => process.exit(0));
		});
	}

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(config.port, config.host, () => {
			server.off('error', reject);
			resolve();
		});
	});
	log.info(
		{
			host: config.host,
			port: config.port,
			origin: config.origin,
			env: config.isProduction ? 'production' : 'development'
		},
		'gateway listening'
	);
	return close;
}

await createApp().catch((error: unknown) => {
	logger.fatal({ error }, 'gateway failed to start');
	process.exit(1);
});
