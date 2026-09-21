/**
 * Admin web sessions (T-27).
 *
 * Cookie-based sessions for the dashboard — deliberately separate from the MCP
 * API keys: different actors (a person in a browser vs. an AI client), different
 * lifetimes (12 h vs. months), different revocation semantics.
 *
 * Rules that matter for security rather than convenience:
 *  - the session id is 32 random bytes, the database stores it directly (it is a
 *    bearer secret presented in an HttpOnly cookie; there is no password to hash)
 *  - an unknown email and a wrong password take the *same* time and return the
 *    *same* message, so the form cannot be used to enumerate accounts
 *  - 5 failures against one account lock it for 15 minutes; the counter lives on
 *    the user row so a distributed source cannot reset it by switching IPs
 *  - resolving a session re-checks the user's status, which is what makes
 *    "disable this person" take effect immediately rather than at their next login
 */
import { randomBytes } from 'node:crypto';
import { count, eq, gt, lte } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.ts';
import { users, webSessions } from '../db/schema.ts';
import { verifySafe } from '../security/password.ts';
import { isoFromNow, isPast, nowIso } from '../../shared/time.ts';
import { recordAudit } from '../observability/audit.ts';

export const SESSION_COOKIE = 'mcpgw_session';
export const SESSION_TTL_HOURS = 12;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export type AdminUser = {
	id: string;
	email: string;
	role: 'admin' | 'viewer';
	status: 'active' | 'disabled';
};

export type LoginOutcome =
	| { ok: true; user: AdminUser; session: { id: string; expiresAt: string } }
	| { ok: false; reason: 'invalid-credentials' }
	| { ok: false; reason: 'locked'; retryAfterSeconds: number };

/** One message for "no such user" and "wrong password", hence no enumeration. */
const INVALID_CREDENTIALS = 'Email or password is incorrect.';

export function loginErrorMessage(outcome: Extract<LoginOutcome, { ok: false }>): string {
	return outcome.reason === 'locked'
		? `Too many failed attempts. Try again in ${Math.max(1, Math.ceil(outcome.retryAfterSeconds / 60))} minute(s).`
		: INVALID_CREDENTIALS;
}

function toUser(row: typeof users.$inferSelect): AdminUser {
	return { id: row.id, email: row.email, role: row.role, status: row.status };
}

export async function verifyAdminLogin(
	input: { email: string; password: string; ip?: string; requestId?: string; db?: Db },
	now: Date = new Date()
): Promise<LoginOutcome> {
	const db = input.db ?? getDb();
	const email = input.email.trim().toLowerCase();
	const row = db.select().from(users).where(eq(users.email, email)).get();

	if (!row) {
		// burn the same time a real verification would take
		await verifySafe(undefined, input.password);
		return { ok: false, reason: 'invalid-credentials' };
	}

	if (row.lockedUntil && !isPast(row.lockedUntil, now.toISOString())) {
		const retryAfterSeconds = Math.max(
			1,
			Math.floor((new Date(row.lockedUntil).getTime() - now.getTime()) / 1000)
		);
		return { ok: false, reason: 'locked', retryAfterSeconds };
	}

	if (row.status === 'disabled') {
		// same wording as a bad password: a disabled account should not advertise itself
		await verifySafe(row.passwordHash, input.password);
		return { ok: false, reason: 'invalid-credentials' };
	}

	const valid = await verifySafe(row.passwordHash, input.password);
	if (!valid) {
		const failed = row.failedAttempts + 1;
		const locked = failed >= MAX_FAILED_LOGINS;
		db.update(users)
			.set({
				failedAttempts: locked ? 0 : failed,
				lockedUntil: locked ? isoFromNow(LOCKOUT_MINUTES * 60_000, now) : null,
				updatedAt: nowIso(now)
			})
			.where(eq(users.id, row.id))
			.run();
		recordAudit({
			actorType: 'user',
			actorId: row.id,
			action: 'admin.login_failure',
			targetType: 'user',
			targetId: row.id,
			ip: input.ip,
			requestId: input.requestId,
			meta: { attempt: failed, locked },
			db
		});
		return locked
			? { ok: false, reason: 'locked', retryAfterSeconds: LOCKOUT_MINUTES * 60 }
			: { ok: false, reason: 'invalid-credentials' };
	}

	db.update(users)
		.set({ failedAttempts: 0, lockedUntil: null, updatedAt: nowIso(now) })
		.where(eq(users.id, row.id))
		.run();
	const session = createAdminSession(row.id, { ip: input.ip, db }, now);
	recordAudit({
		actorType: 'user',
		actorId: row.id,
		action: 'admin.login',
		targetType: 'user',
		targetId: row.id,
		ip: input.ip,
		requestId: input.requestId,
		db
	});
	return { ok: true, user: toUser(row), session };
}

export function createAdminSession(
	userId: string,
	options: { ip?: string; userAgent?: string; db?: Db } = {},
	now: Date = new Date()
): { id: string; expiresAt: string } {
	const db = options.db ?? getDb();
	const id = randomBytes(32).toString('base64url');
	const expiresAt = isoFromNow(SESSION_TTL_HOURS * 3_600_000, now);
	db.insert(webSessions)
		.values({
			id,
			userId,
			ip: options.ip ?? null,
			userAgent: options.userAgent?.slice(0, 300) ?? null,
			createdAt: nowIso(now),
			expiresAt
		})
		.run();
	return { id, expiresAt };
}

/** `Secure` only over HTTPS, so http://localhost stays usable in development. */
export function sessionCookieAttributes(expiresAt: string, secure: boolean) {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure,
		expires: new Date(expiresAt),
		maxAge: SESSION_TTL_HOURS * 3_600
	};
}

export function resolveAdminSession(
	cookieValue: string | undefined,
	options: { db?: Db } = {},
	now: Date = new Date()
): { user: AdminUser; sessionId: string } | undefined {
	if (!cookieValue || cookieValue.length < 16) return undefined;
	const db = options.db ?? getDb();
	const row = db
		.select({ session: webSessions, user: users })
		.from(webSessions)
		.innerJoin(users, eq(webSessions.userId, users.id))
		.where(eq(webSessions.id, cookieValue))
		.get();
	if (!row) return undefined;
	if (isPast(row.session.expiresAt, now.toISOString())) {
		destroyAdminSession(row.session.id, { db });
		return undefined;
	}
	if (row.user.status === 'disabled') return undefined; // remote logout takes effect immediately
	return { user: toUser(row.user), sessionId: row.session.id };
}

/** Logout: the row is removed, so a copied cookie is useless after this point. */
export function destroyAdminSession(sessionId: string, options: { db?: Db } = {}): void {
	try {
		(options.db ?? getDb()).delete(webSessions).where(eq(webSessions.id, sessionId)).run();
	} catch {
		// never fail a logout over bookkeeping
	}
}

export function destroySessionByValue(
	cookieValue: string | undefined,
	options: { db?: Db } = {}
): void {
	if (!cookieValue) return;
	destroyAdminSession(cookieValue, options);
}

/** Force-logout from the Users page (disable, role change, offboarding). */
export function revokeSessionsForUser(userId: string, options: { db?: Db } = {}): number {
	const db = options.db ?? getDb();
	const existing = db
		.select({ id: webSessions.id })
		.from(webSessions)
		.where(eq(webSessions.userId, userId))
		.all();
	db.delete(webSessions).where(eq(webSessions.userId, userId)).run();
	return existing.length;
}

export type ActiveSession = {
	id: string;
	userId: string;
	email: string;
	ip: string | null;
	userAgent: string | null;
	createdAt: string;
	expiresAt: string;
};

/** Sessions an operator can see and revoke from the Users page. */
export function listActiveSessions(db: Db = getDb(), now: Date = new Date()): ActiveSession[] {
	const rows = db
		.select()
		.from(webSessions)
		.where(gt(webSessions.expiresAt, nowIso(now)))
		.all();
	const byId = new Map(
		db
			.select()
			.from(users)
			.all()
			.map((user) => [user.id, user])
	);
	return rows.map((row) => ({
		id: row.id,
		userId: row.userId,
		email: byId.get(row.userId)?.email ?? '(deleted user)',
		ip: row.ip,
		userAgent: row.userAgent,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt
	}));
}

/** Retention (T-46): expired sessions are dead weight and can be pruned. */
export function pruneExpiredSessions(db: Db = getDb(), now: Date = new Date()): number {
	const cutoff = nowIso(now);
	const [{ value: stale }] = db
		.select({ value: count() })
		.from(webSessions)
		.where(lte(webSessions.expiresAt, cutoff))
		.all();
	db.delete(webSessions).where(lte(webSessions.expiresAt, cutoff)).run();
	return stale;
}

/** Unlock an account early (operator action after a support conversation). */
export function clearLoginLockout(userId: string, options: { db?: Db } = {}): void {
	(options.db ?? getDb())
		.update(users)
		.set({ failedAttempts: 0, lockedUntil: null, updatedAt: nowIso() })
		.where(eq(users.id, userId))
		.run();
}
