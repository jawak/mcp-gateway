/**
 * MCP session registry (T-13 core; the transport plumbing is in gateway.ts).
 *
 * One entry per authenticated client session: the MCP server instance, its
 * transport, and the caller it belongs to. Responsibilities:
 *   - O(1) lookup by `Mcp-Session-Id` on every request
 *   - `lastSeenAt` bookkeeping so idle sessions can be garbage collected
 *     (MCPGW_SESSION_TTL_MIN, default 30 min)
 *   - immediate teardown of every session belonging to a key that was revoked or
 *     suspended — a revoked key must stop working within seconds, not at the end
 *     of the idle window (FR-03)
 *   - the live count exposed on /healthz and as `mcp_active_sessions`
 *
 * Database rows (`mcp_sessions`) are written through the optional `store`
 * adapter so this module stays usable in tests without a database.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpCaller } from './backend.ts';
import { status } from '../observability/status.ts';
import { events } from '../registry/events.ts';
import { logger as rootLogger } from '../observability/logger.ts';
import { nowIso } from '../../shared/time.ts';

export type SessionStore = {
	created: (session: GatewaySession) => void;
	seen: (sessionId: string, at: string) => void;
	closed: (sessionId: string, reason: string) => void;
};

export type GatewaySession = {
	id: string;
	caller: McpCaller;
	server: Server;
	transport: WebStandardStreamableHTTPServerTransport;
	createdAt: string;
	lastSeenAt: number;
	/** Detaches list-changed subscriptions; replaced by the real unsubscribe once
	 * the session is registered. */
	unwatch: () => void;
};

export type CloseReason = 'client' | 'revoked' | 'suspended' | 'idle' | 'shutdown' | 'error';

export class SessionRegistry {
	#byId = new Map<string, GatewaySession>();
	#byKey = new Map<string, Set<string>>();
	#store: SessionStore | undefined;
	#log;

	constructor(
		options: { store?: SessionStore; logger?: ReturnType<typeof rootLogger.child> } = {}
	) {
		this.#store = options.store;
		this.#log = (options.logger ?? rootLogger).child({ component: 'mcp-sessions' });
	}

	get count(): number {
		return this.#byId.size;
	}

	register(session: Omit<GatewaySession, 'createdAt' | 'lastSeenAt'>): GatewaySession {
		const created: GatewaySession = { ...session, createdAt: nowIso(), lastSeenAt: Date.now() };
		this.#byId.set(created.id, created);
		const forKey = this.#byKey.get(created.caller.apiKeyId) ?? new Set<string>();
		forKey.add(created.id);
		this.#byKey.set(created.caller.apiKeyId, forKey);
		status.activeSessions = this.#byId.size;
		this.#store?.created(created);
		this.#log.debug({ sessionId: created.id, key: created.caller.keyName }, 'session opened');
		return created;
	}

	get(id: string | null | undefined): GatewaySession | undefined {
		if (!id) return undefined;
		const session = this.#byId.get(id);
		if (session) {
			session.lastSeenAt = Date.now();
			this.#store?.seen(session.id, nowIso());
		}
		return session;
	}

	/** Remove from the index without releasing (used by the transport callbacks). */
	#detach(id: string): GatewaySession | undefined {
		const session = this.#byId.get(id);
		if (!session) return undefined;
		this.#byId.delete(id);
		const forKey = this.#byKey.get(session.caller.apiKeyId);
		forKey?.delete(id);
		if (forKey && forKey.size === 0) this.#byKey.delete(session.caller.apiKeyId);
		status.activeSessions = this.#byId.size;
		return session;
	}

	async close(id: string, reason: CloseReason): Promise<boolean> {
		const session = this.#detach(id);
		if (!session) return false;
		await this.#release(session, reason);
		return true;
	}

	/** FR-03: a revoked/suspended key stops working within seconds. */
	async closeForKey(apiKeyId: string, reason: CloseReason): Promise<number> {
		const ids = [...(this.#byKey.get(apiKeyId) ?? [])];
		for (const id of ids) await this.close(id, reason);
		if (ids.length > 0)
			this.#log.info({ keyId: apiKeyId, sessions: ids.length, reason }, 'closed sessions for key');
		return ids.length;
	}

	/** Idle sessions are closed and their rows marked. Returns the closed ids. */
	async collectGarbage(ttlMs: number, now: number = Date.now()): Promise<string[]> {
		const closed: string[] = [];
		for (const session of [...this.#byId.values()]) {
			if (now - session.lastSeenAt < ttlMs) continue;
			await this.close(session.id, 'idle');
			closed.push(session.id);
		}
		if (closed.length > 0) this.#log.info({ closed: closed.length, ttlMs }, 'idle sessions closed');
		return closed;
	}

	/** All live session ids for a profile (used by cache invalidation notices). */
	forProfile(profileId: string): GatewaySession[] {
		return [...this.#byId.values()].filter((session) => session.caller.profileId === profileId);
	}

	list(): Array<{
		id: string;
		keyName: string;
		profileId: string;
		createdAt: string;
		idleMs: number;
		client?: string;
	}> {
		return [...this.#byId.values()].map((session) => ({
			id: session.id,
			keyName: session.caller.keyName,
			profileId: session.caller.profileId,
			createdAt: session.createdAt,
			idleMs: Date.now() - session.lastSeenAt,
			client: session.caller.clientInfo?.name
		}));
	}

	async closeAll(reason: CloseReason = 'shutdown'): Promise<void> {
		for (const session of [...this.#byId.values()]) await this.close(session.id, reason);
	}

	async #release(session: GatewaySession, reason: CloseReason): Promise<void> {
		session.unwatch();
		try {
			await session.transport.close();
		} catch {
			/* the client is already gone */
		}
		try {
			await session.server.close();
		} catch {
			/* ignore */
		}
		this.#store?.closed(session.id, reason);
		events.emit('session.closed', { sessionId: session.id, reason });
		this.#log.debug({ sessionId: session.id, reason }, 'session closed');
	}
}
