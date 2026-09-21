/**
 * Admin login and web-session lifecycle (T-27).
 *
 * Covers what the acceptance calls for: success sets a session, repeated wrong
 * passwords lock the account for 15 minutes, expiry ends a session, logout
 * removes the row — plus the enumeration-resistance properties, which are the
 * part a UI test would never notice.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import {
	LOCKOUT_MINUTES,
	MAX_FAILED_LOGINS,
	SESSION_TTL_HOURS,
	clearLoginLockout,
	createAdminSession,
	destroyAdminSession,
	destroySessionByValue,
	listActiveSessions,
	loginErrorMessage,
	pruneExpiredSessions,
	resolveAdminSession,
	revokeSessionsForUser,
	sessionCookieAttributes,
	verifyAdminLogin
} from '../../src/lib/server/governance/adminsession';
import { hashPassword } from '../../src/lib/server/security/password';
import { users, webSessions } from '../../src/lib/server/db/schema';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { uuidv7 } from '../../src/lib/shared/ids';
import { isoFromNow } from '../../src/lib/shared/time';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-login-'));
const PASSWORD = 'correct horse battery staple';

async function makeUser(
	options: {
		email?: string;
		password?: string;
		role?: 'admin' | 'viewer';
		status?: 'active' | 'disabled';
	} = {}
) {
	const id = uuidv7();
	const email = (options.email ?? `user-${id.slice(-8)}@example.com`).toLowerCase();
	getDb()
		.insert(users)
		.values({
			id,
			email,
			passwordHash: await hashPassword(options.password ?? PASSWORD),
			role: options.role ?? 'admin',
			status: options.status ?? 'active'
		})
		.run();
	return { id, email };
}

function attempts(id: string) {
	const row = getDb().select().from(users).where(eq(users.id, id)).get();
	return { failedAttempts: row?.failedAttempts ?? -1, lockedUntil: row?.lockedUntil ?? null };
}

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = 'b'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

describe('successful login', () => {
	test('returns the user and creates a session row', async () => {
		const user = await makeUser();
		const outcome = await verifyAdminLogin({
			email: user.email,
			password: PASSWORD,
			ip: '203.0.113.9'
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.user).toMatchObject({ id: user.id, email: user.email, role: 'admin' });
		expect(outcome.session.id.length).toBeGreaterThan(30);

		const stored = getDb()
			.select()
			.from(webSessions)
			.where(eq(webSessions.id, outcome.session.id))
			.get();
		expect(stored).toMatchObject({ userId: user.id, ip: '203.0.113.9' });
	});

	test('email is matched case-insensitively and trimmed', async () => {
		const created = await makeUser({ email: 'Mixed.Case@Example.com' });
		expect(created.email).toBe('mixed.case@example.com');
		const outcome = await verifyAdminLogin({
			email: '  mixed.CASE@example.com  ',
			password: PASSWORD
		});
		expect(outcome.ok).toBe(true);
	});

	test('a fresh session resolves to the same user', async () => {
		const user = await makeUser();
		const { id } = createAdminSession(user.id, {
			ip: '198.51.100.4',
			userAgent: 'Mozilla/5.0 test'
		});
		const resolved = resolveAdminSession(id);
		expect(resolved?.user.id).toBe(user.id);
	});

	test('cookie attributes are HttpOnly, SameSite=Lax, path-scoped and expiring', () => {
		const attributes = sessionCookieAttributes(isoFromNow(SESSION_TTL_HOURS * 3_600_000), true);
		expect(attributes.httpOnly).toBe(true);
		expect(attributes.sameSite).toBe('lax');
		expect(attributes.secure).toBe(true);
		expect(attributes.path).toBe('/');
		expect(attributes.maxAge).toBe(SESSION_TTL_HOURS * 3600);
		// over plain http the Secure flag would make the cookie unusable in dev
		expect(sessionCookieAttributes(isoFromNow(1000), false).secure).toBe(false);
	});
});

describe('credential failures resist enumeration', () => {
	test('unknown account and wrong password give the same message', async () => {
		const user = await makeUser();
		const wrongPassword = await verifyAdminLogin({
			email: user.email,
			password: 'not the password'
		});
		const unknownEmail = await verifyAdminLogin({
			email: 'nobody-here@example.com',
			password: PASSWORD
		});
		expect(wrongPassword.ok).toBe(false);
		expect(unknownEmail.ok).toBe(false);
		if (wrongPassword.ok || unknownEmail.ok) return;
		expect(loginErrorMessage(wrongPassword)).toBe(loginErrorMessage(unknownEmail));
		expect(loginErrorMessage(unknownEmail)).not.toContain('unknown');
	});

	test('an unknown account costs roughly the same time as a wrong password', async () => {
		// without the dummy hash this pair differs by an order of magnitude, which
		// turns the login form into an account-enumeration oracle
		const user = await makeUser();
		const timed = async (fn: () => Promise<unknown>) => {
			const started = performance.now();
			await fn();
			return performance.now() - started;
		};
		// warm the argon2 path so the first measurement is not dominated by module work
		await verifyAdminLogin({ email: user.email, password: 'warmup' });
		const [wrong, unknown] = await Promise.all([
			timed(() => verifyAdminLogin({ email: user.email, password: 'again wrong' })),
			timed(() =>
				verifyAdminLogin({ email: `ghost-${uuidv7().slice(-6)}@example.com`, password: PASSWORD })
			)
		]);
		expect(Math.max(wrong, unknown) / Math.min(wrong, unknown)).toBeLessThan(3);
	});

	test('a disabled account cannot sign in, and says nothing about being disabled', async () => {
		const user = await makeUser({ status: 'disabled' });
		const outcome = await verifyAdminLogin({ email: user.email, password: PASSWORD });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(loginErrorMessage(outcome)).toBe('Email or password is incorrect.');
	});
});

describe('lockout (5 failures → 15 minutes)', () => {
	test('the counter climbs and the account locks at the threshold', async () => {
		const user = await makeUser();
		for (let index = 1; index <= MAX_FAILED_LOGINS; index += 1) {
			const outcome = await verifyAdminLogin({ email: user.email, password: 'wrong' });
			if (index < MAX_FAILED_LOGINS) {
				expect(outcome.ok).toBe(false);
				if (!outcome.ok) expect(outcome.reason).toBe('invalid-credentials');
				expect(attempts(user.id).failedAttempts).toBe(index);
			} else {
				expect(outcome.ok).toBe(false);
				if (!outcome.ok) expect(outcome.reason).toBe('locked');
			}
		}
		const state = attempts(user.id);
		expect(state.lockedUntil).toBeTruthy();
		expect(state.failedAttempts).toBe(0); // reset so the next window starts clean

		// even the correct password is refused while locked
		const correct = await verifyAdminLogin({ email: user.email, password: PASSWORD });
		expect(correct.ok).toBe(false);
		if (!correct.ok) {
			expect(correct.reason).toBe('locked');
			expect(loginErrorMessage(correct)).toContain('15 minute');
		}
	});

	test('a lock that has expired lets the correct password through', async () => {
		const user = await makeUser();
		for (let index = 0; index < MAX_FAILED_LOGINS; index += 1) {
			await verifyAdminLogin({ email: user.email, password: 'wrong' });
		}
		// rewind the lock instead of sleeping 15 minutes
		getDb()
			.update(users)
			.set({ lockedUntil: isoFromNow(-(LOCKOUT_MINUTES * 60_000 + 5_000)) })
			.where(eq(users.id, user.id))
			.run();
		const outcome = await verifyAdminLogin({ email: user.email, password: PASSWORD });
		expect(outcome.ok).toBe(true);
	});

	test('an operator can clear a lockout early', async () => {
		const user = await makeUser();
		for (let index = 0; index < MAX_FAILED_LOGINS; index += 1) {
			await verifyAdminLogin({ email: user.email, password: 'wrong' });
		}
		clearLoginLockout(user.id);
		expect(attempts(user.id).lockedUntil).toBeNull();
		expect((await verifyAdminLogin({ email: user.email, password: PASSWORD })).ok).toBe(true);
	});

	test('a successful login resets the failure counter', async () => {
		const user = await makeUser();
		await verifyAdminLogin({ email: user.email, password: 'wrong' });
		await verifyAdminLogin({ email: user.email, password: 'wrong' });
		expect(attempts(user.id).failedAttempts).toBe(2);
		await verifyAdminLogin({ email: user.email, password: PASSWORD });
		expect(attempts(user.id).failedAttempts).toBe(0);
	});
});

describe('session lifecycle', () => {
	test('an expired session stops resolving and its row is dropped', async () => {
		const user = await makeUser();
		const session = createAdminSession(user.id);
		getDb()
			.update(webSessions)
			.set({ expiresAt: isoFromNow(-1_000) })
			.where(eq(webSessions.id, session.id))
			.run();
		expect(resolveAdminSession(session.id)).toBeUndefined();
		expect(
			getDb().select().from(webSessions).where(eq(webSessions.id, session.id)).get()
		).toBeUndefined();
	});

	test('disabling a user ends their live sessions immediately (remote logout)', async () => {
		const user = await makeUser();
		const session = createAdminSession(user.id);
		expect(resolveAdminSession(session.id)?.user.id).toBe(user.id);
		getDb().update(users).set({ status: 'disabled' }).where(eq(users.id, user.id)).run();
		expect(resolveAdminSession(session.id)).toBeUndefined();
	});

	test('logout deletes the row so a copied cookie becomes useless', async () => {
		const user = await makeUser();
		const session = createAdminSession(user.id);
		destroyAdminSession(session.id);
		expect(resolveAdminSession(session.id)).toBeUndefined();

		const second = createAdminSession(user.id);
		destroySessionByValue(second.id);
		expect(resolveAdminSession(second.id)).toBeUndefined();
		destroySessionByValue(undefined); // no-op, must not throw
	});

	test('a short or forged cookie value is rejected without touching the database', () => {
		expect(resolveAdminSession(undefined)).toBeUndefined();
		expect(resolveAdminSession('')).toBeUndefined();
		expect(resolveAdminSession('short')).toBeUndefined();
		expect(resolveAdminSession('mcpgw-not-a-real-session-id-value')).toBeUndefined();
	});

	test('sessions can be listed and revoked per user', async () => {
		const user = await makeUser();
		createAdminSession(user.id, { ip: '203.0.113.1', userAgent: 'agent-a' });
		createAdminSession(user.id, { ip: '203.0.113.2', userAgent: 'agent-b' });
		const mine = listActiveSessions().filter((session) => session.userId === user.id);
		expect(mine).toHaveLength(2);
		expect(mine[0]?.email).toBe(user.email);
		expect(revokeSessionsForUser(user.id)).toBe(2);
		expect(listActiveSessions().filter((session) => session.userId === user.id)).toEqual([]);
	});

	test('expired rows are pruned without touching live ones', async () => {
		const user = await makeUser();
		const live = createAdminSession(user.id);
		const dead = createAdminSession(user.id);
		getDb()
			.update(webSessions)
			.set({ expiresAt: isoFromNow(-60_000) })
			.where(eq(webSessions.id, dead.id))
			.run();
		expect(pruneExpiredSessions()).toBeGreaterThanOrEqual(1);
		expect(resolveAdminSession(live.id)?.user.id).toBe(user.id);
	});
});

describe('audit', () => {
	test('successful and failed logins are recorded', async () => {
		const user = await makeUser();
		await verifyAdminLogin({
			email: user.email,
			password: 'nope',
			ip: '203.0.113.77',
			requestId: 'req-login-1'
		});
		await verifyAdminLogin({
			email: user.email,
			password: PASSWORD,
			ip: '203.0.113.77',
			requestId: 'req-login-2'
		});
		const { auditLog } = await import('../../src/lib/server/db/schema.ts');
		const actions = getDb()
			.select()
			.from(auditLog)
			.all()
			.filter((row) => row.actorId === user.id)
			.map((row) => row.action);
		expect(actions).toContain('admin.login_failure');
		expect(actions).toContain('admin.login');
	});
});

afterAll(() => {
	// the connection must close before the file goes away, otherwise later tests in
	// the same process would hit a deleted database
	rmSync(dir, { recursive: true, force: true });
});
