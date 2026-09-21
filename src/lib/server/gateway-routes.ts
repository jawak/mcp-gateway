/**
 * Gateway-owned routes, shared by the production router and the dev hook.
 *
 * These endpoints (`/mcp`, `/metrics`, `/healthz`) are not SvelteKit routes: in
 * production the Bun router handles them before SvelteKit ever sees them, while in
 * `vite dev` only the SvelteKit server exists. Handling them in one place keeps
 * the semantics (405 vs 404, body cap, token protection) identical in both modes,
 * so a route that works in dev cannot silently behave differently in production.
 */
import { json, PayloadTooLargeError } from './http/bridge.ts';
import { notReadyResponse } from './readiness.ts';
import type { MigrationsState } from './db/migrate.ts';
import type { RequestContext } from '../../handle.ts';

const MCP_METHODS = ['POST', 'GET', 'DELETE'];

const READY: MigrationsState = { ok: true, version: 1, expected: 1 };

export type GatewayRoutes = {
	mcp: (request: Request, context: RequestContext) => Promise<Response>;
	metrics?: { expose(): Promise<string>; token?: string; beforeScrape?: () => void };
	healthz: () => Record<string, unknown>;
	maxBodyBytes?: number;
	/**
	 * Schema-readiness probe. Injected rather than read from a global here: this
	 * module is the pure routing layer, and opening a database inside it would make
	 * the router untestable and couple route semantics to filesystem state.
	 * Defaults to ready, so embedders and tests need not know about it.
	 */
	readiness?: () => MigrationsState;
};

/** Returns undefined when the path belongs to the application, not the gateway. */
export async function tryHandleGatewayRoute(
	request: Request,
	context: RequestContext,
	routes: GatewayRoutes
): Promise<Response | undefined> {
	const path = normalisePath(new URL(request.url).pathname);
	const schemaState = routes.readiness ? routes.readiness() : READY;

	switch (path) {
		// 200 even when not ready: the container healthcheck must surface the problem
		// without restart-looping a process that only needs one command from a human
		case '/healthz':
			return json({
				...routes.healthz(),
				ok: schemaState.ok,
				schema: schemaState.ok ? 'ready' : schemaState.reason,
				...(schemaState.ok ? {} : { hint: schemaState.hint })
			});

		case '/metrics':
			// metrics stay available: the readiness gauges are how an operator learns
			// about the outage in the first place
			return await handleMetrics(request, routes.metrics);

		case '/mcp': {
			// refuse before touching auth or a session: a missing schema would surface
			// as a 500 stack from the registry instead of this one clear answer
			if (!schemaState.ok) return notReadyResponse(schemaState);
			// MCP Streamable HTTP allows only POST/GET/DELETE; refuse the rest before
			// authentication so a bad verb never touches a session
			if (!MCP_METHODS.includes(request.method.toUpperCase())) {
				return json(
					{ error: 'method_not_allowed' },
					{ status: 405, headers: { allow: MCP_METHODS.join(', ') } }
				);
			}
			const capped = await capBody(request, routes.maxBodyBytes);
			if (capped.error) return capped.error;
			return routes.mcp(capped.request ?? request, context);
		}

		default:
			return undefined;
	}
}

function normalisePath(pathname: string): string {
	if (pathname === '/') return pathname;
	return pathname.replace(/\/+$/, '');
}

/**
 * Enforce the body cap on `/mcp`.
 *
 * A declared `Content-Length` is rejected up front; a chunked body is wrapped in a
 * counting stream that fails with `PayloadTooLargeError` while it is read, so the
 * limit holds even when a client omits or lies about the length. Entrypoints map
 * that error to 413.
 */
async function capBody(
	request: Request,
	maxBodyBytes?: number
): Promise<{ request?: Request; error?: Response }> {
	if (!maxBodyBytes) return {};
	if (request.method.toUpperCase() !== 'POST' || !request.body) return {};
	const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
	if (Number.isFinite(declared) && declared > maxBodyBytes) {
		return { error: tooLarge(maxBodyBytes) };
	}
	let received = 0;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			received += chunk.byteLength;
			if (received > maxBodyBytes) {
				controller.error(new PayloadTooLargeError(maxBodyBytes));
				return;
			}
			controller.enqueue(chunk);
		}
	});
	return {
		request: new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body.pipeThrough(counter),
			duplex: 'half'
		} as RequestInit)
	};
}

export function tooLarge(limitBytes: number): Response {
	return json(
		{ error: 'payload_too_large', message: `request body exceeds ${limitBytes} bytes` },
		{ status: 413 }
	);
}

async function handleMetrics(
	request: Request,
	metrics?: GatewayRoutes['metrics']
): Promise<Response> {
	if (!metrics?.token) {
		// no token configured ⇒ the endpoint is not exposed at all: unauthenticated
		// metrics leak key names and traffic shape
		return json({ error: 'not_found' }, { status: 404 });
	}
	const provided = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '').trim();
	if (!timingSafeEqual(provided, metrics.token)) {
		return json(
			{ error: 'unauthorized' },
			{ status: 401, headers: { 'www-authenticate': 'Bearer realm="metrics"' } }
		);
	}
	metrics.beforeScrape?.();
	return new Response(await metrics.expose(), {
		status: 200,
		headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }
	});
}

/** Constant-time compare so a probe cannot binary-search the token. */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1)
		diff |= (a.charCodeAt(index) ^ b.charCodeAt(index))!;
	return diff === 0;
}
