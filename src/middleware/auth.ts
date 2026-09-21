/**
 * Authentication boundary for `/mcp` (T-22).
 *
 * The MCP endpoint is the only public surface of the gateway, so this is where
 * the hostile-input assumptions are enforced:
 *
 *  - **Bearer API key** → verified against the hash index; the reason codes map
 *    onto the HTTP semantics the key lifecycle defines (401 revoked/unknown/
 *    expired, 403 suspended or IP-restricted).
 *  - **Origin check**: browsers send `Origin` on cross-origin requests; a foreign
 *    Origin means a webpage is trying to drive the endpoint, so it is refused
 *    before any key lookup. Native MCP clients send no Origin and are unaffected.
 *  - **Per-IP failure window**: 10 failures inside a minute gets a minute of
 *    `429`, which turns a brute-force probe into a self-inflicted denial instead
 *    of an unlimited guessing budget.
 *  - **Request budget** comes from the key's profile, so a compromised key can
 *    only spend its own quota.
 *
 * Failures are audited with sampling: logging every failed guess would let an
 * attacker use volume to fill the audit table (and the disk).
 */
import type { Authenticate, AuthResult } from '../lib/server/mcp/gateway.ts';
import type { McpCaller } from '../lib/server/mcp/backend.ts';
import { verifyApiKey, touchApiKey } from '../lib/server/governance/apikey.ts';
import {
	DEFAULT_LIMITS,
	RateLimiter,
	rateLimiter,
	type Limits
} from '../lib/server/governance/ratelimit.ts';
import { getProfile } from '../lib/server/registry/index.ts';
import { recordAudit } from '../lib/server/observability/audit.ts';
import { getConfig } from '../lib/server/config.ts';
import type { Db } from '../lib/server/db/index.ts';
import { logger as rootLogger, type Logger } from '../lib/server/observability/logger.ts';
import { nowIso } from '../lib/shared/time.ts';

const WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 10;
const COOLDOWN_MS = 60_000;
/** `last_used_at` is a convenience column, so 30 s resolution is plenty. */
const TOUCH_INTERVAL_MS = 30_000;
/** Write an audit row for the first failure and then every Nth. */
const AUDIT_EVERY = 10;

type FailureWindow = { count: number; firstAt: number; blockedUntil: number };

export type AuthenticatorOptions = {
	limiter?: RateLimiter;
	db?: Db;
	log?: Logger;
	/** Overridable for tests. */
	now?: () => number;
	/** Metrics sink (T-26). */
	metrics?: { recordRateLimited(keyName: string): void; recordAuthFailure(reason: string): void };
};

export function limitsForProfile(profileId: string): Limits {
	const profile = getProfile(profileId);
	if (!profile) return DEFAULT_LIMITS;
	return {
		rateLimitRpm: profile.rateLimitRpm,
		dailyCallQuota: profile.dailyCallQuota,
		maxConcurrency: profile.maxConcurrency
	};
}

export function createMcpAuthenticator(options: AuthenticatorOptions = {}): Authenticate {
	const config = getConfig();
	const limiter = options.limiter ?? rateLimiter;
	const log = options.log ?? rootLogger.child({ component: 'auth' });
	const now = options.now ?? (() => Date.now());
	const failures = new Map<string, FailureWindow>();
	const lastTouch = new Map<string, number>();

	function recordFailure(ip: string): { blocked: boolean; count: number } {
		const at = now();
		const window = failures.get(ip);
		if (!window || at - window.firstAt > WINDOW_MS) {
			const fresh = { count: 1, firstAt: at, blockedUntil: 0 };
			failures.set(ip, fresh);
			return { blocked: false, count: 1 };
		}
		window.count += 1;
		if (window.count === FAILURE_THRESHOLD) {
			window.blockedUntil = at + COOLDOWN_MS;
			log.warn(
				{ ip, count: window.count },
				'authentication failures exceeded the window, backing off'
			);
		}
		if (window.count > 10_000) failures.delete(ip); // never let the map itself be an attack
		return { blocked: at < window.blockedUntil, count: window.count };
	}

	function clearFailure(ip: string): void {
		failures.delete(ip);
	}

	return async function authenticate(request, context): Promise<AuthResult> {
		const ip = context.clientAddress;

		// 1. cross-origin browser traffic is never a legitimate MCP client
		const origin = request.headers.get('origin');
		if (origin && origin !== 'null' && origin !== config.origin) {
			return {
				response: jsonResponse(
					403,
					{ error: 'forbidden_origin' },
					{ 'x-request-id': context.requestId }
				)
			};
		}

		// 2. this IP already burned its allowance of wrong keys
		const window = failures.get(ip);
		if (window && now() < window.blockedUntil) {
			const retryAfter = Math.ceil((window.blockedUntil - now()) / 1000);
			return {
				response: jsonResponse(
					429,
					{ error: 'too_many_authentication_failures', retry_after_seconds: retryAfter },
					{ 'retry-after': String(retryAfter), 'www-authenticate': 'Bearer realm="mcp"' }
				)
			};
		}

		// 3. verify the key
		const outcome = await verifyApiKey(request.headers.get('authorization'), {
			ip,
			db: options.db
		});
		if (!outcome.ok) {
			// Only a bad or unknown credential counts against the source address.
			// Expired/revoked/suspended keys are real credentials that simply no longer
			// work, and `no-profile` can be a momentary cache race — counting those would
			// lock an operator out of their own gateway for a minute.
			const guessed = outcome.reason === 'malformed' || outcome.reason === 'unknown';
			const state = guessed ? recordFailure(ip) : { blocked: false, count: 0 };
			options.metrics?.recordAuthFailure(outcome.reason);
			if (state.count === 1 || state.count % AUDIT_EVERY === 0) {
				recordAudit({
					actorType: 'api_key',
					actorId: null,
					action: 'mcp.auth_failure',
					targetType: 'mcp_endpoint',
					targetId: outcome.reason,
					ip,
					requestId: context.requestId,
					meta: { reason: outcome.reason, attempts: state.count },
					db: options.db
				});
			}
			const status = outcome.status;
			const body =
				status === 403
					? { error: outcome.reason === 'suspended' ? 'key_suspended' : 'ip_not_allowed' }
					: { error: 'invalid_api_key', reason: outcome.reason };
			return {
				response: jsonResponse(
					status,
					state.blocked ? { error: 'too_many_authentication_failures' } : body,
					{
						'www-authenticate': 'Bearer realm="mcp"',
						...(state.blocked ? { 'retry-after': String(Math.ceil(COOLDOWN_MS / 1000)) } : {})
					}
				)
			};
		}
		clearFailure(ip);

		// 4. the key's own request budget
		const limits = limitsForProfile(outcome.profileId);
		const budget = limiter.takeRequest(outcome.key.id, limits, now());
		if (!budget.ok) {
			options.metrics?.recordRateLimited(outcome.key.name);
			return {
				response: jsonResponse(
					429,
					{ error: 'rate_limited', retry_after_ms: budget.retryAfterMs },
					{ ...RateLimiter.headers({ retryAfterMs: budget.retryAfterMs }, budget.remaining) }
				)
			};
		}

		// 5. daily quota
		if (!limiter.hasDailyQuota(outcome.key.id, limits)) {
			return {
				response: jsonResponse(
					429,
					{ error: 'daily_quota_exhausted', limit: limits.dailyCallQuota },
					{ 'x-ratelimit-remaining': '0' }
				)
			};
		}

		// 6. cheap, debounced bookkeeping
		const previousTouch = lastTouch.get(outcome.key.id) ?? 0;
		if (now() - previousTouch > TOUCH_INTERVAL_MS) {
			lastTouch.set(outcome.key.id, now());
			touchApiKey(outcome.key.id, options.db);
		}

		const caller: McpCaller = {
			apiKeyId: outcome.key.id,
			keyName: outcome.key.name,
			profileId: outcome.profileId,
			requestId: context.requestId,
			clientAddress: ip
		};
		return caller;
	};
}

function jsonResponse(
	status: number,
	body: Record<string, unknown>,
	headers: Record<string, string> = {}
): Response {
	return new Response(JSON.stringify({ ...body, ts: nowIso() }), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}
