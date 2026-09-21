/**
 * Audit trail (T-25 core, used from T-21 onwards).
 *
 * Append-only by construction: this module exposes `record()` and read helpers
 * only — there is deliberately no update or delete, and the API never exposes
 * one (the retention job in T-46 is the only thing that prunes, and only by age).
 *
 * Failures to write are logged loudly but never propagated: losing an audit row
 * must not take down an admin action that already happened.
 */
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.ts';
import { auditLog } from '../db/schema.ts';
import { uuidv7 } from '../../shared/ids.ts';
import { nowIso } from '../../shared/time.ts';
import { redactValue } from '../security/redact.ts';
import { logger as rootLogger, type Logger } from '../observability/logger.ts';

export type ActorKind = 'user' | 'api_key' | 'system';

export type AuditEntry = {
	actorType: ActorKind;
	actorId?: string | null;
	action: string;
	targetType: string;
	targetId?: string | null;
	ip?: string | null;
	requestId?: string | null;
	meta?: Record<string, unknown> | null;
	db?: Db;
};

let log: Logger | undefined;

/** Write one audit row. Never throws. */
export function recordAudit(entry: AuditEntry): void {
	try {
		(entry.db ?? getDb())
			.insert(auditLog)
			.values({
				id: uuidv7(),
				actorType: entry.actorType,
				actorId: entry.actorId ?? null,
				action: entry.action,
				targetType: entry.targetType,
				targetId: entry.targetId ?? null,
				ip: entry.ip ?? null,
				requestId: entry.requestId ?? null,
				meta: entry.meta
					? (redactValue(entry.meta, { maxDepth: 4 }) as Record<string, unknown>)
					: null,
				createdAt: nowIso()
			})
			.run();
	} catch (error) {
		log ??= rootLogger.child({ component: 'audit' });
		log.error({ err: error, action: entry.action }, 'audit row could not be written');
	}
}

export type AuditFilter = {
	actorId?: string;
	targetId?: string;
	action?: string;
	from?: string;
	to?: string;
	limit?: number;
};

/**
 * Delete audit rows older than `days`. Returns how many were removed.
 *
 * This is the only sanctioned way anything leaves the audit table, and it is age
 * based: no code path deletes by actor, action or target (BR: append-only).
 */
export function pruneAudit(days: number, db: Db = getDb()): number {
	const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();
	const [{ value: stale }] = db
		.select({ value: count() })
		.from(auditLog)
		.where(lte(auditLog.createdAt, cutoff))
		.all();
	db.delete(auditLog).where(lte(auditLog.createdAt, cutoff)).run();
	return stale;
}

/** RFC 4180 quoting so a value containing a comma or newline cannot forge columns. */
function csvCell(value: unknown): string {
	const text =
		value === null || value === undefined
			? ''
			: typeof value === 'string'
				? value
				: JSON.stringify(value);
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV export for the admin log page (T-36). */
export function auditToCsv(rows: ReturnType<typeof listAudit>): string {
	const header = [
		'created_at',
		'actor_type',
		'actor_id',
		'action',
		'target_type',
		'target_id',
		'ip',
		'request_id',
		'meta'
	];
	const lines = [header.join(',')];
	for (const row of rows) {
		lines.push(
			[
				row.createdAt,
				row.actorType,
				row.actorId,
				row.action,
				row.targetType,
				row.targetId,
				row.ip,
				row.requestId,
				row.meta
			]
				.map(csvCell)
				.join(',')
		);
	}
	return `${lines.join('\r\n')}\r\n`;
}

/** Newest first, capped — used by the admin timeline (T-36) and CSV export. */
export function listAudit(filter: AuditFilter = {}, db: Db = getDb()) {
	const conditions = [];
	if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
	if (filter.targetId) conditions.push(eq(auditLog.targetId, filter.targetId));
	if (filter.action) conditions.push(eq(auditLog.action, filter.action));
	if (filter.from) conditions.push(gte(auditLog.createdAt, filter.from));
	if (filter.to) conditions.push(lte(auditLog.createdAt, filter.to));
	const where = conditions.length > 0 ? and(...conditions) : undefined;
	return db
		.select()
		.from(auditLog)
		.where(where)
		.orderBy(desc(auditLog.createdAt))
		.limit(Math.min(filter.limit ?? 200, 1_000))
		.all();
}
