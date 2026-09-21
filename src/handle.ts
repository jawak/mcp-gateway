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
import { json } from './lib/server/http/bridge.ts';
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
	version?: string;
	maxBodyBytes?: number;
	trustProxy?: boolean;
};

const MCP_METHODS = ['POST', 'GET', 'DELETE'];

export function createFetchHandler(deps: RouterDeps): (request: Request) => Promise<Response> {
	const { sveltekit } = deps;
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
				return decorate(handleMetrics());
			case '/mcp':
				return decorate(await handleMcp(request, requestId, maxBodyBytes));
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

function handleMetrics(): Response {
	return json(
		{ error: 'not_implemented', message: 'Prometheus exposition arrives in T-26' },
		{ status: 501 }
	);
}

async function handleMcp(
	request: Request,
	requestId: string,
	maxBodyBytes: number
): Promise<Response> {
	const method = request.method.toUpperCase();
	if (!MCP_METHODS.includes(method)) {
		return json(
			{ error: 'method_not_allowed' },
			{ status: 405, headers: { allow: MCP_METHODS.join(', ') } }
		);
	}
	if (method === 'POST' && request.body) {
		// The body is drained here so the 1 MB cap is enforced now, before T-12
		// mounts the real transport on this route.
		const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
		if (Number.isFinite(declared) && declared > maxBodyBytes) return tooLarge(maxBodyBytes);
		const body = await request.arrayBuffer();
		if (body.byteLength > maxBodyBytes) return tooLarge(maxBodyBytes);
	}
	return json(
		{ error: 'not_mounted', message: 'MCP transport arrives in T-12' },
		{ status: 503, headers: { 'x-request-id': requestId } }
	);
}

function tooLarge(limitBytes: number): Response {
	return json(
		{ error: 'payload_too_large', message: `request body exceeds ${limitBytes} bytes` },
		{ status: 413 }
	);
}
