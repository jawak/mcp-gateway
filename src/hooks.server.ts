import type { Handle } from '@sveltejs/kit';
import {
	resolveAdminSession,
	destroyAdminSession,
	SESSION_COOKIE
} from '$lib/server/governance/adminsession';
import { decideAccess, securityHeaders } from '$lib/server/governance/rbac';

/**
 * Server hook: session → access policy → security headers (T-28).
 *
 * Order matters: the session is resolved first so the policy sees the role, and
 * headers are applied to *every* response — a missing header on a 404 page is
 * still a missing header.
 */
export const handle = (async ({ event, resolve }) => {
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
	const decorated = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: { ...Object.fromEntries(response.headers), ...securityHeaders() }
	});
	return decorated;
}) satisfies Handle;

/**
 * SvelteKit checks the Origin of state-changing requests against the Host, which
 * is our CSRF defence for form actions. It is on by default; stated explicitly so
 * nobody "optimises" it away.
 */
export const config = {
	csrf: { checkOrigin: true }
	// CSP + its script nonce are configured in vite.config.ts (`csp` is kit config,
	// consumed at build time); `cspDirectives()` there mirrors the policy that
	// src/lib/server/governance/rbac.ts documents and tests.
};
