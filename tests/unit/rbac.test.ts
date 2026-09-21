import { describe, expect, test } from 'bun:test';
import {
	cspDirectives,
	decideAccess,
	isPublicPath,
	isSafeRedirectTarget,
	securityHeaders
} from '../../src/lib/server/governance/rbac';

const admin = { role: 'admin', status: 'active' } as const;
const viewer = { role: 'viewer', status: 'active' } as const;
const disabled = { role: 'admin', status: 'disabled' } as const;

describe('public paths', () => {
	test('login and health are reachable without a session', () => {
		for (const path of ['/login', '/healthz', '/_app/immutable/entry/app.js', '/favicon.png']) {
			expect(isPublicPath(path), path).toBe(true);
		}
		for (const path of ['/admin', '/admin/upstreams', '/api/v1/logs']) {
			expect(isPublicPath(path), path).toBe(false);
		}
	});
});

describe('access decisions', () => {
	test('an anonymous visitor is sent to login with the target preserved', () => {
		const decision = decideAccess({ pathname: '/admin/keys', method: 'GET', user: null });
		expect(decision).toEqual({ action: 'redirect', to: '/login?next=%2Fadmin%2Fkeys' });
	});

	test('an anonymous API caller gets 403, not a login page', () => {
		// a fetch that silently returned HTML would "succeed" and then fail confusingly
		expect(decideAccess({ pathname: '/api/v1/logs', method: 'GET', user: null })).toEqual({
			action: 'unauthorized',
			reason: 'authentication required'
		});
	});

	test('an authenticated admin may do anything', () => {
		expect(decideAccess({ pathname: '/admin', method: 'GET', user: admin })).toEqual({
			action: 'allow'
		});
		expect(decideAccess({ pathname: '/admin/upstreams/new', method: 'POST', user: admin })).toEqual(
			{ action: 'allow' }
		);
		expect(decideAccess({ pathname: '/admin/keys/x', method: 'DELETE', user: admin })).toEqual({
			action: 'allow'
		});
	});

	test('a viewer may read but never mutate (BR: role-based access)', () => {
		expect(decideAccess({ pathname: '/admin/logs', method: 'GET', user: viewer })).toEqual({
			action: 'allow'
		});
		expect(decideAccess({ pathname: '/admin/logs', method: 'HEAD', user: viewer })).toEqual({
			action: 'allow'
		});
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(
				decideAccess({ pathname: '/admin/upstreams/new', method, user: viewer }),
				method
			).toEqual({
				action: 'forbidden',
				reason: 'admin role required'
			});
		}
	});

	test('a disabled account is refused even with a valid session (remote logout)', () => {
		expect(decideAccess({ pathname: '/admin', method: 'GET', user: disabled })).toEqual({
			action: 'forbidden',
			reason: 'account disabled'
		});
	});

	test('the public login page stays reachable while logged out', () => {
		expect(decideAccess({ pathname: '/login', method: 'POST', user: null })).toEqual({
			action: 'allow'
		});
	});
});

describe('open-redirect guard', () => {
	test('only same-origin absolute paths are accepted as next targets', () => {
		expect(isSafeRedirectTarget('/admin')).toBe(true);
		expect(isSafeRedirectTarget('/admin/keys?tab=active')).toBe(true);
		// `//host` and `/\host` are treated as absolute by browsers
		expect(isSafeRedirectTarget('//evil.example')).toBe(false);
		expect(isSafeRedirectTarget('/\\evil.example')).toBe(false);
		expect(isSafeRedirectTarget('https://evil.example')).toBe(false);
		expect(isSafeRedirectTarget('evil.example')).toBe(false);
		expect(isSafeRedirectTarget('')).toBe(false);
		expect(isSafeRedirectTarget(null)).toBe(false);
	});
});

describe('security headers', () => {
	test('every response gets the baseline set, without CSP', () => {
		const headers = securityHeaders();
		expect(headers['x-content-type-options']).toBe('nosniff');
		expect(headers['x-frame-options']).toBe('DENY');
		expect(headers['referrer-policy']).toBe('same-origin');
		// CSP is set before rendering so SvelteKit can add its script nonce
		expect(headers['content-security-policy']).toBeUndefined();
	});

	test('CSP blocks injected script and framing', () => {
		const directives = cspDirectives();
		// Kit adds the quotes, so the config values are unquoted
		expect(directives['default-src']).toEqual(['self']);
		expect(directives['script-src']).toEqual(['self']);
		expect(directives['frame-ancestors']).toEqual(['none']);
		expect(directives['form-action']).toEqual(['self']);
		expect(directives['base-uri']).toEqual(['self']);
		// inline script must not be licensed wholesale: SvelteKit supplies a nonce
		expect(directives['script-src']).not.toContain('unsafe-inline');
		// third-party origins would be an exfiltration channel
		const serialised = JSON.stringify(directives);
		expect(serialised).not.toContain('cdn.');
		expect(serialised).not.toContain('http:');
	});

	test('vite.config.ts declares the same policy (kit reads it at build time)', async () => {
		const source = await Bun.file('vite.config.ts').text();
		expect(source).toContain("mode: 'nonce'");
		for (const directive of [
			'default-src',
			'script-src',
			'frame-ancestors',
			'form-action',
			'base-uri'
		]) {
			expect(source, directive).toContain(`'${directive}'`);
		}
		// keep the two copies literally identical
		const expected = Object.entries(cspDirectives())
			.map(([name, values]) => `'${name}': [${values.map((value) => `'${value}'`).join(', ')}]`)
			.join(',');
		const flattened = source.replace(/\s+/g, '');
		expect(flattened).toContain(expected.replace(/\s+/g, ''));
	});

	test('permissions policy disables device APIs the console never uses', () => {
		const headers = securityHeaders();
		for (const feature of ['geolocation', 'microphone', 'camera', 'payment', 'usb']) {
			expect(headers['permissions-policy']).toContain(`${feature}=()`);
		}
	});
});
