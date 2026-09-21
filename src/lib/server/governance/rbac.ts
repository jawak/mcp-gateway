/**
 * Admin access policy and security headers (T-28).
 *
 * Both live here as pure functions so the rules can be tested exhaustively
 * without a running app — an access-control bug is exactly the kind you want
 * caught by a table of cases rather than by a click-through.
 *
 * Policy:
 *  - `/admin/*` requires an authenticated, active user
 *  - read-only methods (`GET`, `HEAD`, `OPTIONS`) also allow the `viewer` role
 *  - everything that can change state (`POST`, `PUT`, `PATCH`, `DELETE`) is
 *    `admin`-only — SvelteKit form actions are POSTs, so this is what enforces
 *    "a viewer cannot change anything"
 *  - unauthenticated HTML requests are redirected to `/login`; API-ish paths get
 *    a 401 instead of a redirect, so a broken fetch fails honestly rather than
 *    "succeeding" with an HTML body
 */

export type Role = 'admin' | 'viewer';
export type UserStatus = 'active' | 'disabled';

export type AccessSubject = { role: Role; status: UserStatus } | null | undefined;

export type AccessDecision =
	| { action: 'allow' }
	| { action: 'redirect'; to: string }
	| { action: 'unauthorized'; reason: string }
	| { action: 'forbidden'; reason: string };

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Paths reachable without a session: the login page and its own actions. */
const PUBLIC_PATHS = new Set(['/', '/login', '/healthz']);
const PUBLIC_PREFIXES = ['/login', '/_app/', '/favicon'];

export function isPublicPath(pathname: string): boolean {
	return (
		PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
	);
}

export function isMutatingMethod(method: string): boolean {
	return !READ_METHODS.has(method.toUpperCase());
}

export function decideAccess(input: {
	pathname: string;
	method: string;
	user: AccessSubject;
	/** Paths under `/api/*` get 401 instead of a login redirect. */
	apiPaths?: string[];
}): AccessDecision {
	const { pathname, method, user } = input;
	if (isPublicPath(pathname)) return { action: 'allow' };

	// An unauthenticated API caller gets an honest 401; only browser navigation is
	// redirected, otherwise a broken fetch "succeeds" with an HTML login page.
	if (!user) {
		return isApiPath(pathname, input.apiPaths ?? ['/api/'])
			? { action: 'unauthorized', reason: 'authentication required' }
			: { action: 'redirect', to: `/login?next=${encodeURIComponent(pathname)}` };
	}
	if (user.status === 'disabled') {
		return { action: 'forbidden', reason: 'account disabled' };
	}

	if (isMutatingMethod(method) && user.role !== 'admin') {
		return { action: 'forbidden', reason: 'admin role required' };
	}
	return { action: 'allow' };
}

function isApiPath(pathname: string, prefixes: string[]): boolean {
	return prefixes.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Only same-origin, single-slash paths may be used as post-login targets.
 * `//host` and `\host` are treated as absolute by browsers, so accepting them
 * would turn `?next=` into an open redirect to an attacker's host.
 */
export function isSafeRedirectTarget(value: string | null | undefined): boolean {
	if (!value || !value.startsWith('/')) return false;
	if (value.startsWith('//') || value.startsWith('/\\')) return false;
	return !value.includes('\\');
}

/**
 * Content-Security-Policy for the dashboard.
 * Baseline CSP for the console.
 *
 * `'unsafe-inline'` for styles is deliberate: Tailwind and Chart.js both write
 * inline styles, and a nonce pipeline for those is not worth its maintenance
 * cost in a self-hosted admin console. Scripts stay `'self'`-only, which is what
 * actually matters for injected-content risk.
 *
 * SvelteKit emits one inline bootstrap script; with `csp: { mode: 'nonce' }` in
 * the hooks it appends `'nonce-…'` to `script-src` — but only if this header
 * already exists before rendering, which is why the hook sets it pre-resolve.
 */
/**
 * The policy. SvelteKit needs it as kit config in `vite.config.ts` (read at build
 * time), so that file holds the literal copy and this function is the documented,
 * testable source of truth the two are kept aligned by `rbac.test.ts`.
 */
export function cspDirectives(): Record<string, string[]> {
	return {
		'default-src': ['self'],
		'script-src': ['self'],
		'style-src': ['self', 'unsafe-inline'],
		'img-src': ['self', 'data:'],
		'font-src': ['self', 'data:'],
		'connect-src': ['self'],
		'frame-ancestors': ['none'],
		'base-uri': ['self'],
		'form-action': ['self']
	};
}

/**
 * Headers applied to every response. CSP is deliberately excluded here: it has to
 * be set before rendering so SvelteKit can extend it (see `cspPolicy`).
 */
export function securityHeaders(): Record<string, string> {
	return {
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'same-origin',
		'x-frame-options': 'DENY',
		'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
	};
}
