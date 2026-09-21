import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The gateway has no landing page: the root goes straight to the console, and
 *  the server hook bounces unauthenticated visitors to /login. */
export const load = (() => {
	throw redirect(303, '/admin');
}) satisfies PageServerLoad;
