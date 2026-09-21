/**
 * Gateway composition root (T-22 wiring).
 *
 * Builds the long-lived objects of the API process and connects them:
 *   registry snapshot → catalog → backend → MCP endpoint → /mcp route
 *   auth boundary     → key verification, request budget, daily quota
 *   backend guard     → per-key concurrency slot + daily quota consumption
 *   event bus         → cache invalidation and instant session teardown
 *
 * Keeping this in one file means the wiring is readable end to end, and the
 * entrypoint stays a thin adapter over it (which is also what makes the whole
 * gateway mountable in tests without a process).
 */
import { createMcpEndpoint, type Authenticate, type McpEndpoint } from './mcp/gateway.ts';
import { createGatewayBackend } from './mcp/handlers.ts';
import { ToolCatalog } from './mcp/catalog.ts';
import { SessionRegistry } from './mcp/session.ts';
import { UpstreamPool } from './upstream/pool.ts';
import { rateLimiter, type RateLimiter } from './governance/ratelimit.ts';
import { limitsForProfile } from '../../middleware/auth.ts';
import { events } from './registry/events.ts';
import { listUpstreams } from './registry/index.ts';
import { getDb } from './db/index.ts';
import { mcpSessions } from './db/schema.ts';
import { nowIso } from '../shared/time.ts';
import { eq } from 'drizzle-orm';
import { logger } from './observability/logger.ts';

export type GatewayApp = {
	endpoint: McpEndpoint;
	pool: UpstreamPool;
	catalog: ToolCatalog;
	sessions: SessionRegistry;
	/** Close pooled connections and every live session. */
	shutdown(): Promise<void>;
};

export function createGatewayApp(options: {
	limiter?: RateLimiter;
	authenticate: Authenticate;
	metrics?: NonNullable<Parameters<typeof createGatewayBackend>[0]['metrics']>;
}): GatewayApp {
	const db = getDb();
	const limiter = options.limiter ?? rateLimiter;
	const log = logger.child({ component: 'gateway-app' });
	const pool = new UpstreamPool();
	const catalog = new ToolCatalog({ pool });
	const sessions = new SessionRegistry({ store: createSessionStore(db) });

	const backend = createGatewayBackend({
		catalog,
		pool,
		db,
		metrics: options.metrics,
		// per-key concurrency + daily quota; the auth boundary already covers the
		// request budget so a burst cannot even reach here
		guard: {
			acquire: async (caller) => {
				const limits = limitsForProfile(caller.profileId);
				const release = await limiter.acquire(caller.apiKeyId, limits);
				limiter.consumeDaily(caller.apiKeyId, db);
				return release;
			}
		}
	});

	const endpoint = createMcpEndpoint({ backend, sessions, authenticate: options.authenticate });

	// cache invalidation on config/health changes + instant teardown on revocation
	const offCatalog = catalog.watchInvalidations();
	const offRevoked = events.on('key.revoked', ({ keyId }) => {
		void sessions.closeForKey(keyId, 'revoked');
	});
	const offSuspended = events.on('key.suspended', ({ keyId }) => {
		void sessions.closeForKey(keyId, 'suspended');
	});
	const offUpstreamRemoved = events.on('upstream.enabled', ({ slug, enabled }) => {
		if (enabled) return;
		void pool.close(slug, { graceMs: 1_000, reason: 'manual' });
	});

	// Warm the pinned upstreams in the background. Deliberately not awaited: one
	// slow or broken upstream must not delay the gateway accepting requests, and the
	// pool retries on first use anyway.
	void pool.warm(listUpstreams()).then((result) => {
		if (result.failed.length > 0) {
			logger.warn(
				{ failed: result.failed.map((entry) => entry.slug) },
				'some pinned upstreams did not start'
			);
		}
	});

	return {
		endpoint,
		pool,
		catalog,
		sessions,
		async shutdown() {
			offCatalog();
			offRevoked();
			offSuspended();
			offUpstreamRemoved();
			await sessions.closeAll('shutdown');
			await pool.closeAll(5_000);
			log.info('gateway resources released');
		}
	};
}

/**
 * Mirrors the session registry into `mcp_sessions`. Deliberately best-effort:
 * a session must open even when the database is having a bad day, and the rows
 * exist for operators, not for correctness.
 */
function createSessionStore(db: ReturnType<typeof getDb>): import('./mcp/session.ts').SessionStore {
	return {
		created: (session) => {
			try {
				db.insert(mcpSessions)
					.values({
						id: session.id,
						apiKeyId: session.caller.apiKeyId,
						profileId: session.caller.profileId,
						protocolVersion: session.caller.protocolVersion ?? null,
						clientInfo: (session.caller.clientInfo as Record<string, unknown> | undefined) ?? null,
						createdAt: nowIso(),
						lastSeenAt: nowIso()
					})
					.onConflictDoNothing()
					.run();
			} catch {
				// ignore
			}
		},
		seen: (sessionId, at) => {
			try {
				db.update(mcpSessions).set({ lastSeenAt: at }).where(eq(mcpSessions.id, sessionId)).run();
			} catch {
				// ignore
			}
		},
		closed: (sessionId) => {
			try {
				db.update(mcpSessions)
					.set({ closedAt: nowIso() })
					.where(eq(mcpSessions.id, sessionId))
					.run();
			} catch {
				// ignore
			}
		}
	};
}
