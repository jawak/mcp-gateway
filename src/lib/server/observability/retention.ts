/**
 * Retention and housekeeping jobs (T-13 GC, T-46 retention/backup).
 *
 * All of these are age-based and idempotent: re-running a job that already ran
 * deletes nothing extra, which matters because the worker can restart at any point
 * (deploys, crashes, containers being rescheduled).
 */
import { and, isNull, lt, sql } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.ts';
import { mcpSessions, upstreamHealth } from '../db/schema.ts';
import { pruneToolCalls } from './usage-query.ts';
import { pruneAudit } from './audit.ts';
import { pruneExpiredSessions } from '../governance/adminsession.ts';
import { effectiveSettings } from '../settings.ts';

/** Close and drop MCP sessions idle beyond the configured TTL (FR: idle GC). */
export function collectIdleSessions(db: Db = getDb()): { closed: number; deleted: number } {
	const ttlMin = effectiveSettings(db).sessionTtlMin;
	const cutoff = new Date(Date.now() - ttlMin * 60_000).toISOString();
	const stale = db
		.select({ id: mcpSessions.id })
		.from(mcpSessions)
		.where(and(lt(mcpSessions.lastSeenAt, cutoff), isNull(mcpSessions.closedAt)))
		.all();
	db.update(mcpSessions)
		.set({ closedAt: new Date().toISOString() })
		.where(lt(mcpSessions.lastSeenAt, cutoff))
		.run();
	// rows already closed long ago are pure noise
	const deleted =
		db
			.select({ value: sql<number>`count(*)` })
			.from(mcpSessions)
			.where(lt(mcpSessions.createdAt, new Date(Date.now() - 7 * 86_400_000).toISOString()))
			.all()[0]?.value ?? 0;
	db.delete(mcpSessions)
		.where(lt(mcpSessions.createdAt, new Date(Date.now() - 7 * 86_400_000).toISOString()))
		.run();
	return { closed: stale.length, deleted };
}

/** Apply every configured retention window. Returns what each job removed. */
export function runRetention(db: Db = getDb()): Record<string, number> {
	const settings = effectiveSettings(db);
	return {
		toolCalls: pruneToolCalls(settings.retentionToolCallsDays, db),
		audit: pruneAudit(settings.retentionAuditDays, db),
		health: pruneHealth(settings.retentionHealthDays, db),
		webSessions: pruneExpiredSessions(db)
	};
}

export function pruneHealth(days: number, db: Db = getDb()): number {
	const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
	const [{ value: stale }] = db
		.select({ value: sql<number>`count(*)` })
		.from(upstreamHealth)
		.where(lt(upstreamHealth.checkedAt, cutoff))
		.all();
	db.delete(upstreamHealth).where(lt(upstreamHealth.checkedAt, cutoff)).run();
	return stale;
}
