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
import {
	PayloadTooLargeError,
	toWebRequest,
	writePlainError,
	writeWebResponse
} from '../lib/server/http/bridge.ts';
import { serveStatic } from '../lib/server/http/static.ts';
import { events } from '../lib/server/registry/events.ts';
import { runtime } from '../lib/server/runtime.ts';
import { logger } from '../lib/server/observability/logger.ts';

const log = logger.child({ component: 'server' });

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
	const root = resolveRoot();
	const clientDir = path.join(root, 'build', 'client');
	const app = await loadSvelteKit(root);

	await app.init({
		env: process.env as Record<string, string>,
		read: (file) => Bun.file(path.join(clientDir, file)) as unknown as ReadableStream
	});
	log.info({ root, version: runtime.version }, 'sveltekit server initialised');

	const handleFetch = createFetchHandler({
		sveltekit: async (request, context) => {
			const staticResponse = await serveStatic(request, { root: clientDir });
			if (staticResponse) return staticResponse;
			return app.respond(request, { getClientAddress: () => context.clientAddress });
		},
		version: runtime.version,
		maxBodyBytes: runtime.maxBodyBytes
	});

	const server = http.createServer(async (req, res) => {
		try {
			const request = await toWebRequest(req, {
				trustProxy: runtime.trustProxy,
				maxBodyBytes: runtime.maxBodyBytes
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
			}, runtime.gracefulShutdownMs);
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
		server.listen(runtime.port, runtime.host, () => {
			server.off('error', reject);
			resolve();
		});
	});
	log.info({ host: runtime.host, port: runtime.port }, 'gateway listening');
	return close;
}

await createApp().catch((error: unknown) => {
	logger.fatal({ error }, 'gateway failed to start');
	process.exit(1);
});
