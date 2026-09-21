import type { Handle, RequestEvent } from '@sveltejs/kit';
import { decideAccess, securityHeaders } from '$lib/server/governance/rbac';
import { tryHandleGatewayRoute } from '$lib/server/gateway-routes';
import { healthzPayload, type RequestContext } from './handle';
import { clientIp } from '$lib/server/http/forwarded';
import { migrationsState, notReadyHtmlResponse, resetReadinessCache } from '$lib/server/readiness';
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

	// The dashboard cannot do anything without the schema, and letting it try turns a
	// one-command fix into a stack trace on every page.
	if (!migrationsState().ok) return withSecurityHeaders(notReadyHtmlResponse());

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
	} else if (decision.action === 'unauthorized') {
		response = new Response(JSON.stringify({ error: 'unauthorized', reason: decision.reason }), {
			status: 401,
			headers: { 'content-type': 'application/json', 'www-authenticate': 'session' }
		});
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
let gatewayPromise: Promise<Awaited<ReturnType<typeof buildGatewayRoutes>>> | undefined;

function gatewayRoutes() {
	gatewayPromise ??= buildGatewayRoutes().catch((error: unknown) => {
		// Do not cache a failed init: an operator who runs `bun run db:migrate` in a
		// second terminal while `vite dev` is up must be served on the next request,
		// not permanently bricked for the lifetime of the process.
		gatewayPromise = undefined;
		throw error;
	});
	return gatewayPromise;
}

async function buildGatewayRoutes() {
	const [
		{ createGatewayApp },
		{ createMcpAuthenticator },
		{ metrics },
		{ ensureLoaded },
		{ getConfig },
		migrateModule,
		seedModule
	] = await Promise.all([
		import('$lib/server/gateway-app'),
		import('./middleware/auth'),
		import('$lib/server/observability/metrics'),
		import('$lib/server/registry/index'),
		import('$lib/server/config'),
		import('$lib/server/db/migrate'),
		import('$lib/server/db/seed')
	]);
	const config = getConfig();

	// `vite dev` has no Bun entrypoint of its own, and the production entrypoint
	// already migrates before it accepts a request — so dev does the same here, or a
	// fresh clone cannot start at all. Never in production: N web replicas racing DDL
	// is an outage, and the single-writer rule lives in the Tech Spec.
	if (!config.isProduction) {
		const { version } = migrateModule.runMigrations();
		const seeded = await seedModule.seedAdmin();
		// the readiness verdict may have been cached as "not ready" by the request
		// that triggered this very migration
		resetReadinessCache();
		console.log(
			`[dev] schema at version ${version} · admin bootstrap: ${seeded.reason}${seeded.created ? ` (${seeded.email})` : ''}`
		);
	}

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
		maxBodyBytes: config.maxBodyBytes,
		readiness: migrationsState
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
