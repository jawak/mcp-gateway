/**
 * Request router (T-02).
 *
 * Precedence:
 *   1. /healthz, /metrics, /mcp — gateway routes (see gateway-routes.ts, which the
 *      dev-mode hook uses too so both modes behave identically)
 *   2. /*                       — SvelteKit (dashboard, form actions, REST routes)
 *
 * Every response carries `X-Request-Id` so a client can correlate its logs,
 * `tool_calls.request_id` and the admin log page.
 */
import { randomUUID } from 'node:crypto';
import { json } from './lib/server/http/bridge.ts';
import { clientIp } from './lib/server/http/forwarded.ts';
import { getConfig } from './lib/server/config.ts';
import { status, uptimeSeconds } from './lib/server/observability/status.ts';
import { tryHandleGatewayRoute } from './lib/server/gateway-routes.ts';
import type { MigrationsState } from './lib/server/db/migrate.ts';

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
	/**
	 * Schema-readiness probe. Left undefined here — and therefore treated as ready —
	 * so tests and embedders can build a router with no database at all. The
	 * production entrypoint wires the real probe; that is the composition root's job,
	 * not the routing layer's.
	 */
	readiness?: () => MigrationsState;
};

export function createFetchHandler(deps: RouterDeps): (request: Request) => Promise<Response> {
	const { sveltekit, mcp, metrics } = deps;
	// Config is only consulted for values the caller did not provide, so tests and
	// embedders can build a router without any environment variables.
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

		const decorate = (response: Response): Response => {
			if (response.headers.get('x-request-id') === requestId) return response;
			const headers = new Headers(response.headers);
			headers.set('x-request-id', requestId);
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers
			});
		};

		const gatewayResponse = await tryHandleGatewayRoute(request, context, {
			mcp: mcp ?? (async () => notMounted()),
			metrics,
			healthz: () => healthzPayload(version),
			maxBodyBytes,
			readiness: deps.readiness
		});
		if (gatewayResponse) return decorate(gatewayResponse);

		return decorate(await sveltekit(request, context));
	};
}

export function healthzPayload(version: string): Record<string, unknown> {
	return {
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
	};
}

function notMounted(): Response {
	return json(
		{ error: 'not_mounted', message: 'MCP transport is not mounted on this process' },
		{ status: 503 }
	);
}
