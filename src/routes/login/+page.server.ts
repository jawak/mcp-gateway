import { fail, redirect, type Actions } from '@sveltejs/kit';
import { verifySafe } from '$lib/server/security/password';
import { isSafeRedirectTarget } from '$lib/server/governance/rbac';
import {
	SESSION_COOKIE,
	createAdminSession,
	loginErrorMessage,
	sessionCookieAttributes,
	verifyAdminLogin
} from '$lib/server/governance/adminsession';

/**
 * Login (T-27). Logout lives on the admin layout, next to the sign-out control.
 *
 * Both actions would have to be named: SvelteKit rejects a `default` action
 * coexisting with named ones, so the form posts to `?/login`.
 *
 * The form deliberately never says whether the email exists — an unknown account
 * and a wrong password get the same message *and* the same work (a dummy hash
 * verification), so the page cannot be used to enumerate accounts.
 */
export const actions = {
	login: async ({ request, cookies, getClientAddress }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '');
		const password = String(data.get('password') ?? '');
		const next = String(data.get('next') ?? '/admin');

		if (!email || !password) {
			// same shape as a credential failure, so timing does not leak either
			await verifySafe(undefined, password || 'placeholder');
			return fail(400, { email, message: 'Email and password are required.' });
		}

		const outcome = await verifyAdminLogin({ email, password, ip: getClientAddress() });
		if (!outcome.ok) {
			return fail(outcome.reason === 'locked' ? 429 : 401, {
				email,
				locked: outcome.reason === 'locked',
				message: loginErrorMessage(outcome)
			});
		}

		const session = createAdminSession(outcome.user.id, {
			ip: getClientAddress(),
			userAgent: request.headers.get('user-agent') ?? undefined
		});
		cookies.set(
			SESSION_COOKIE,
			session.id,
			sessionCookieAttributes(session.expiresAt, isSecure(request))
		);
		throw redirect(303, isSafeRedirectTarget(next) ? next : '/admin');
	}
} satisfies Actions;

/** `Secure` over HTTPS only, so http://localhost stays usable in development. */
function isSecure(request: Request): boolean {
	const proto = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim();
	return proto === 'https' || new URL(request.url).protocol === 'https:';
}
