import type { Handle, RequestEvent } from '@sveltejs/kit';
import { decideAccess, securityHeaders } from '$lib/server/governance/rbac';
import { tryHandleGatewayRoute } from '$lib/server/gateway-routes';
import { healthzPayload, type RequestContext } from './handle';
import { clientIp } from '$lib/server/http/forwarded';
import {
	resolveAdminSession,
	destroyAdminSession,
	SESSION_COOKIE
} from '$lib/server/governance/adminsession';

/**
 * Server hook: gateway routes → session → access policy → security headers (T-28).
 *
 * Order matters: the gateway routes bypass the admin session entirely (they use
 * their own bearer/token auth), the session is resolved next so the policy sees
 * the role, and headers are applied to *every* response — a missing header on a
 * 404 page is still a missing header.
 */
export const handle = (async ({ event, resolve }) => {
	// In production the Bun router answers these before SvelteKit is involved;
	// under `vite dev` this is the only place they exist. Handling them in one
	// module means a route that works in dev cannot behave differently in prod.
	const gatewayResponse = await tryHandleGatewayRoute(
		event.request,
		requestContext(event),
		await gatewayRoutes()
	);
	if (gatewayResponse) return withSecurityHeaders(gatewayResponse);

	const cookieValue = event.cookies.get(SESSION_COOKIE);
	const resolved = cookieValue ? resolveAdminSession(cookieValue) : undefined;

	if (cookieValue && !resolved) {
		// an expired or orphaned cookie is dropped so the browser stops resending it
		event.cookies.delete(SESSION_COOKIE, { path: '/' });
	}

	event.locals.user = resolved?.user ?? null;
	event.locals.sessionId = resolved?.sessionId ?? null;

	const decision = decideAccess({
		pathname: event.url.pathname,
		method: event.request.method,
		user: event.locals.user
	});

	let response: Response;
	if (decision.action === 'redirect') {
		response = new Response(null, { status: 303, headers: { location: decision.to } });
	} else if (decision.action === 'forbidden') {
		// drop the dead session so the user is not stuck in a forbidden loop
		if (resolved) {
			destroyAdminSession(resolved.sessionId);
			event.cookies.delete(SESSION_COOKIE, { path: '/' });
		}
		response = new Response(JSON.stringify({ error: 'forbidden', reason: decision.reason }), {
			status: 403,
			headers: { 'content-type': 'application/json' }
		});
	} else {
		response = await resolve(event);
	}

	// never clobber what rendering produced (that includes the nonce-augmented CSP)
	return withSecurityHeaders(response);
}) satisfies Handle;

function withSecurityHeaders(response: Response): Response {
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: { ...Object.fromEntries(response.headers), ...securityHeaders() }
	});
}

function requestContext(event: RequestEvent): RequestContext {
	return {
		requestId: event.request.headers.get('x-request-id') ?? crypto.randomUUID(),
		clientAddress: clientIp(
			event.request.headers,
			event.request.headers.get('x-forwarded-for') ?? undefined,
			true
		)
	};
}

/**
 * Lazily built: importing this module (which the build does) must never touch the
 * database. Production serves those paths from the Bun router, so this stays
 * unused there; in dev the first /mcp, /metrics or /healthz request builds it.
 */
let gatewayPromise: ReturnType<typeof buildGatewayRoutes> | undefined;
function gatewayRoutes() {
	gatewayPromise ??= buildGatewayRoutes();
	return gatewayPromise;
}

async function buildGatewayRoutes() {
	const [
		{ createGatewayApp },
		{ createMcpAuthenticator },
		{ metrics },
		{ ensureLoaded },
		{ getConfig }
	] = await Promise.all([
		import('$lib/server/gateway-app'),
		import('./middleware/auth'),
		import('$lib/server/observability/metrics'),
		import('$lib/server/registry/index'),
		import('$lib/server/config')
	]);
	const config = getConfig();
	ensureLoaded();
	const gateway = createGatewayApp({ authenticate: createMcpAuthenticator({ metrics }), metrics });
	return {
		mcp: (request: Request, context: RequestContext) => gateway.endpoint.handle(request, context),
		metrics: {
			expose: () => metrics.expose(),
			token: process.env.MCPGW_METRICS_TOKEN,
			beforeScrape: () =>
				metrics.refreshGauges({
					sessions: gateway.sessions,
					catalog: gateway.catalog,
					pool: gateway.pool
				})
		},
		healthz: () => healthzPayload(config.version),
		maxBodyBytes: config.maxBodyBytes
	};
}

/**
 * SvelteKit checks the Origin of state-changing requests against the Host, which
 * is our CSRF defence for form actions. It is on by default; stated explicitly so
 * nobody "optimises" it away.
 */
export const config = {
	csrf: { checkOrigin: true }
	// CSP and its script nonce are configured in vite.config.ts (`csp` is kit config,
	// read at build time); cspDirectives() in rbac.ts is the documented policy that
	// rbac.test.ts keeps aligned with it.
};
