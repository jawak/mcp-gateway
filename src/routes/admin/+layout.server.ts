import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * The server hook already refuses unauthenticated and non-admin writes; this
 * load function makes the identity available to every admin page and turns a
 * missing session into a redirect even if a route forgets to check.
 */
export const load = (({ locals, url }) => {
	if (!locals.user) {
		throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
	}
	return {
		user: { email: locals.user.email, role: locals.user.role },
		/** Viewers get a read-only UI: no destructive action is offered at all. */
		canWrite: locals.user.role === 'admin'
	};
}) satisfies LayoutServerLoad;
