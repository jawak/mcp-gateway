import { error, json, type RequestHandler } from '@sveltejs/kit';
import { destroySessionByValue, SESSION_COOKIE } from '$lib/server/governance/adminsession';
import { recordAudit } from '$lib/server/observability/audit';

/**
 * Sign-out (T-27).
 *
 * A POST endpoint rather than a form action, because the sign-out control lives in
 * the admin shell that wraps every page — an action would have to be duplicated per
 * route. SvelteKit's CSRF origin check still applies to this request.
 *
 * The session row is deleted, so a copied or stolen cookie stops working here
 * rather than at its natural expiry.
 */
export const POST = (async ({ cookies, locals, getClientAddress }) => {
	if (!locals.user) throw error(401, { message: 'Not signed in' });

	destroySessionByValue(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, { path: '/' });
	recordAudit({
		actorType: 'user',
		actorId: locals.user.id,
		action: 'admin.logout',
		targetType: 'user',
		targetId: locals.user.id,
		ip: getClientAddress()
	});

	return json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } });
}) satisfies RequestHandler;
