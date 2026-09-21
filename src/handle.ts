/**
 * Request router (T-02).
 *
 * Precedence:
 *   1. /healthz — liveness/readiness, no auth
 *   2. /metrics — Prometheus exposition (token auth lands in T-26)
 *   3. /mcp     — MCP Streamable HTTP endpoint (Bearer auth lands in T-22)
 *   4. /*       — SvelteKit (dashboard, form actions, REST routes)
 *
 * Every response carries `X-Request-Id` so a client can correlate its logs,
 * `tool_calls.request_id` and the admin log page.
 */
import { randomUUID } from 'node:crypto';
import { json, PayloadTooLargeError } from './lib/server/http/bridge.ts';
import { clientIp } from './lib/server/http/forwarded.ts';
import { getConfig } from './lib/server/config.ts';
import { status, uptimeSeconds } from './lib/server/observability/status.ts';

/** Everything downstream (SvelteKit, MCP handlers) may need per request. */
export type RequestContext = {
	requestId: string;
	/** Best-effort client IP, honouring one trusted proxy hop. */
	clientAddress: string;
};

export type RouterDeps = {
	/** SvelteKit app: web Request in, web Response out. */
	sveltekit: (request: Request, context: RequestContext) => Promise<Response>;
	/**
	 * MCP endpoint (T-12). Absent until it is mounted, in which case /mcp answers
	 * 503 so operators get an unambiguous signal instead of a silent 404.
	 */
	mcp?: (request: Request, context: RequestContext) => Promise<Response>;
	/**
	 * Prometheus exposition (T-26). Without a token the route stays closed: an
	 * unauthenticated metrics endpoint leaks key names and traffic shape.
	 */
	metrics?: { expose(): Promise<string>; token?: string; beforeScrape?: () => void };
	version?: string;
	maxBodyBytes?: number;
	trustProxy?: boolean;
};

const MCP_METHODS = ['POST', 'GET', 'DELETE'];

export function createFetchHandler(deps: RouterDeps): (request: Request) => Promise<Response> {
	const { sveltekit, mcp, metrics } = deps;
	// Config is only consulted for values the caller did not provide, so tests
	// and embedders can build a router without any environment variables.
	const version = deps.version ?? getConfig().version;
	const maxBodyBytes = deps.maxBodyBytes ?? getConfig().maxBodyBytes;
	const trustProxy = deps.trustProxy ?? getConfig().trustProxy;

	return async function handle(request: Request): Promise<Response> {
		const requestId = request.headers.get('x-request-id') ?? randomUUID();
		const context: RequestContext = {
			requestId,
			clientAddress: clientIp(
				request.headers,
				request.headers.get('x-forwarded-for') ?? undefined,
				trustProxy
			)
		};
		const url = new URL(request.url);
		const path = normalizePath(url.pathname);
		const decorate = (res: Response): Response => {
			if (res.headers.get('x-request-id') === requestId) return res;
			const headers = new Headers(res.headers);
			headers.set('x-request-id', requestId);
			return new Response(res.body, {
				status: res.status,
				statusText: res.statusText,
				headers
			});
		};

		switch (path) {
			case '/healthz':
				return decorate(handleHealthz(version));
			case '/metrics':
				return decorate(await handleMetrics(metrics, request));
			case '/mcp': {
				// MCP Streamable HTTP only allows POST/GET/DELETE; anything else is
				// refused here so it never reaches auth or a session.
				if (!MCP_METHODS.includes(request.method.toUpperCase())) {
					return decorate(methodNotAllowed());
				}
				const limit = await enforceBodyLimit(request, maxBodyBytes);
				if (limit.error) return decorate(limit.error);
				if (!mcp) return decorate(notMounted(requestId));
				return decorate(await mcp(limit.capped ?? request, context));
			}
			default:
				return decorate(await sveltekit(request, context));
		}
	};
}

function normalizePath(pathname: string): string {
	if (pathname === '/') return pathname;
	return pathname.replace(/\/+$/, '');
}

function handleHealthz(version: string): Response {
	return json({
		ok: true,
		version,
		uptime_s: uptimeSeconds(),
		sessions: status.activeSessions,
		upstreams: {
			live: status.liveUpstreams,
			healthy: status.upstreamsHealthy,
			degraded: status.upstreamsDegraded,
			down: status.upstreamsDown,
			unconfigured: status.upstreamsUnconfigured
		},
		last_health_sweep: status.lastHealthSweepAt?.toISOString() ?? null
	});
}

async function handleMetrics(metrics: RouterDeps['metrics'], request: Request): Promise<Response> {
	if (!metrics?.token) {
		// no token configured ⇒ the endpoint is not exposed at all
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

/**
 * Enforce the body cap on `/mcp`.
 *
 * A declared `Content-Length` is rejected up front; a chunked body is wrapped in a
 * counting stream that fails with `PayloadTooLargeError` while it is read, so the
 * limit holds even when a client omits or lies about the length. The entrypoint
 * maps that error to 413.
 */
async function enforceBodyLimit(
	request: Request,
	maxBodyBytes: number
): Promise<{ capped?: Request; error?: Response }> {
	if (request.method.toUpperCase() !== 'POST' || !request.body) return {};
	const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
	if (Number.isFinite(declared) && declared > maxBodyBytes)
		return { error: tooLarge(maxBodyBytes) };

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
	const capped = new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body.pipeThrough(counter),
		duplex: 'half'
	} as RequestInit);
	return { capped };
}

function methodNotAllowed(): Response {
	return json(
		{ error: 'method_not_allowed' },
		{ status: 405, headers: { allow: MCP_METHODS.join(', ') } }
	);
}

function notMounted(requestId: string): Response {
	return json(
		{ error: 'not_mounted', message: 'MCP transport is not mounted on this process' },
		{ status: 503, headers: { 'x-request-id': requestId } }
	);
}

function tooLarge(limitBytes: number): Response {
	return json(
		{ error: 'payload_too_large', message: `request body exceeds ${limitBytes} bytes` },
		{ status: 413 }
	);
}
