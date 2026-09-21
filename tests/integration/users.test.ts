/**
 * Admin account tests (T-39): the guards that keep a console usable.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
	countActiveAdmins,
	createUser,
	listUsers,
	MIN_PASSWORD_LENGTH,
	resetUserPassword,
	setUserRole,
	setUserStatus
} from '../../src/lib/server/governance/users';
import {
	resolveAdminSession,
	createAdminSession
} from '../../src/lib/server/governance/adminsession';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-users-'));
const PASSWORD = 'correct horse battery staple';

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '1'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

describe('creation', () => {
	test('rejects a weak password, a bad email and a duplicate', async () => {
		expect(
			await createUser({ email: 'first@example.com', password: PASSWORD, role: 'admin' }).then(
				(u) => u.email
			)
		).toBe('first@example.com');
		await expect(
			createUser({ email: 'weak@example.com', password: 'short', role: 'admin' })
		).rejects.toThrow(new RegExp(String(MIN_PASSWORD_LENGTH)));
		await expect(
			createUser({ email: 'not-an-email', password: PASSWORD, role: 'admin' })
		).rejects.toThrow(/valid email/);
		await expect(
			createUser({ email: 'first@example.com', password: PASSWORD, role: 'viewer' })
		).rejects.toThrow(/already exists/);
	});

	test('email is normalised to lower case', async () => {
		const created = await createUser({
			email: 'MiXeD@Example.COM',
			password: PASSWORD,
			role: 'viewer'
		});
		expect(created.email).toBe('mixed@example.com');
	});
});

describe('role and status guards', () => {
	test('the last active admin cannot be demoted or disabled', async () => {
		// only one admin exists at this point
		const admins = listUsers().filter((user) => user.role === 'admin' && user.status === 'active');
		expect(admins.length).toBeGreaterThan(0);
		const only = admins[0]!;
		// if other tests added admins, promote-then-test would be flaky: assert on the guard itself
		if (countActiveAdmins() > 1) {
			for (const admin of admins.slice(1))
				setUserStatus(admin.id, 'disabled', { actorId: only.id });
		}
		expect(countActiveAdmins()).toBe(1);
		// actorId is deliberately NOT the target: with the same actor the self-demotion
		// guard fires first, which is a different rule tested below
		expect(() => setUserRole(only.id, 'viewer', { actorId: null })).toThrow(/last active admin/);
		expect(() => setUserStatus(only.id, 'disabled', { actorId: null })).toThrow(
			/last active admin/
		);
		// and the account itself is stopped by the self-demotion guard instead
		expect(() => setUserRole(only.id, 'viewer', { actorId: only.id })).toThrow(
			/your own admin role/
		);
	});

	test('an account cannot remove its own admin role', async () => {
		const me = await createUser({ email: 'self@example.com', password: PASSWORD, role: 'admin' });
		expect(() => setUserRole(me.id, 'viewer', { actorId: me.id })).toThrow(/your own admin role/);
	});

	test('an account cannot disable itself', async () => {
		const me = await createUser({ email: 'self2@example.com', password: PASSWORD, role: 'admin' });
		expect(() => setUserStatus(me.id, 'disabled', { actorId: me.id })).toThrow(/your own account/);
	});

	test('a second admin unblocks demotion of the first', async () => {
		const other = await createUser({
			email: 'second-admin@example.com',
			password: PASSWORD,
			role: 'admin'
		});
		const first = listUsers().find((user) => user.email === 'first@example.com')!;
		expect(() => setUserRole(first.id, 'viewer', { actorId: other.id })).not.toThrow();
	});
});

describe('session consequences', () => {
	test('disabling an account ends its live sessions immediately', async () => {
		const victim = await createUser({
			email: 'victim@example.com',
			password: PASSWORD,
			role: 'viewer'
		});
		const session = createAdminSession(victim.id, { ip: '203.0.113.5' });
		expect(resolveAdminSession(session.id)?.user.id).toBe(victim.id);

		const { sessionsEnded } = setUserStatus(victim.id, 'disabled', { actorId: 'root' });
		expect(sessionsEnded).toBe(1);
		expect(resolveAdminSession(session.id)).toBeUndefined();
	});

	test('a role change also ends sessions so the new rights are unavoidable', async () => {
		const target = await createUser({
			email: 'demote@example.com',
			password: PASSWORD,
			role: 'admin'
		});
		const session = createAdminSession(target.id);
		setUserRole(target.id, 'viewer', { actorId: 'root' });
		expect(resolveAdminSession(session.id)).toBeUndefined();
	});

	test('resetting a password revokes sessions and clears the lockout', async () => {
		const target = await createUser({
			email: 'reset@example.com',
			password: PASSWORD,
			role: 'viewer'
		});
		const session = createAdminSession(target.id);
		await resetUserPassword(target.id, 'another correct horse', { actorId: 'root' });
		expect(resolveAdminSession(session.id)).toBeUndefined();
		expect(listUsers().find((user) => user.id === target.id)?.failedAttempts).toBe(0);
		await expect(resetUserPassword(target.id, 'nope', { actorId: 'root' })).rejects.toThrow(
			/at least/
		);
	});
});

describe('audit', () => {
	test('account actions are recorded', async () => {
		const created = await createUser({
			email: 'audited@example.com',
			password: PASSWORD,
			role: 'viewer'
		});
		setUserStatus(created.id, 'disabled', { actorId: 'root', ip: '203.0.113.9' });
		const { auditLog } = await import('../../src/lib/server/db/schema.ts');
		const { eq } = await import('drizzle-orm');
		const rows = getDb().select().from(auditLog).where(eq(auditLog.targetId, created.id)).all();
		expect(rows.map((row) => row.action)).toContain('user.create');
		expect(rows.map((row) => row.action)).toContain('user.disable');
	});
});

describe('cleanup', () => {
	test('fixture directory is removed', () => {
		rmSync(dir, { recursive: true, force: true });
	});
});
