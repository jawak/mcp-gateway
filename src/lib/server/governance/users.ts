/**
 * Admin user management (T-39).
 *
 * Guards that exist because locking the console out is a real operational
 * failure, not an edge case:
 *  - the last active admin cannot be demoted or disabled, and the account doing
 *    the change cannot demote itself
 *  - disabling an account revokes its live sessions immediately, matching what
 *    the access policy enforces on every request
 *  - passwords go through the same argon2 policy as the bootstrap account, so an
 *    operator cannot create a weaker account through the UI than the CLI allows
 */
import { eq } from 'drizzle-orm';
import { getDb, type Db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import { hashPassword } from '../security/password.ts';
import { uuidv7 } from '../../shared/ids.ts';
import { nowIso } from '../../shared/time.ts';
import { revokeSessionsForUser } from './adminsession.ts';
import { recordAudit } from '../observability/audit.ts';
import { RegistryError } from '../registry/index.ts';

export type AdminUserRow = {
	id: string;
	email: string;
	role: 'admin' | 'viewer';
	status: 'active' | 'disabled';
	failedAttempts: number;
	lockedUntil: string | null;
	createdAt: string;
};

export const MIN_PASSWORD_LENGTH = 12;

export function listUsers(db: Db = getDb()): AdminUserRow[] {
	return db
		.select()
		.from(users)
		.all()
		.map((row) => ({
			id: row.id,
			email: row.email,
			role: row.role,
			status: row.status,
			failedAttempts: row.failedAttempts,
			lockedUntil: row.lockedUntil,
			createdAt: row.createdAt
		}));
}

export function getUser(id: string, db: Db = getDb()): AdminUserRow | undefined {
	return listUsers(db).find((user) => user.id === id);
}

export async function createUser(
	input: { email: string; password: string; role: 'admin' | 'viewer' },
	options: { actorId?: string | null; ip?: string | null; requestId?: string | null; db?: Db } = {}
): Promise<AdminUserRow> {
	const db = options.db ?? getDb();
	const email = input.email.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
		throw new RegistryError('invalid_email', 'enter a valid email address');
	}
	if (input.password.length < MIN_PASSWORD_LENGTH) {
		throw new RegistryError(
			'weak_password',
			`password must be at least ${MIN_PASSWORD_LENGTH} characters`
		);
	}
	if (db.select().from(users).where(eq(users.email, email)).get()) {
		throw new RegistryError('duplicate_email', 'an account with that email already exists');
	}

	const id = uuidv7();
	db.insert(users)
		.values({
			id,
			email,
			passwordHash: await hashPassword(input.password),
			role: input.role,
			status: 'active',
			createdAt: nowIso(),
			updatedAt: nowIso()
		})
		.run();

	recordAudit({
		actorType: 'user',
		actorId: options.actorId ?? null,
		action: 'user.create',
		targetType: 'user',
		targetId: id,
		ip: options.ip ?? null,
		requestId: options.requestId ?? null,
		meta: { email, role: input.role },
		db
	});
	return getUser(id, db) as AdminUserRow;
}

export function setUserRole(
	id: string,
	role: 'admin' | 'viewer',
	options: { actorId?: string | null; ip?: string | null; requestId?: string | null; db?: Db } = {}
): AdminUserRow {
	const db = options.db ?? getDb();
	const target = requireUser(id, db);
	const actorId = options.actorId ?? null;

	if (target.id === actorId && role !== 'admin') {
		throw new RegistryError('self_demotion', 'you cannot remove your own admin role');
	}
	if (role !== 'admin' && target.role === 'admin' && countActiveAdmins(db) <= 1) {
		throw new RegistryError(
			'last_admin',
			'this is the last active admin; promote someone else first'
		);
	}

	db.update(users).set({ role, updatedAt: nowIso() }).where(eq(users.id, id)).run();
	// a role change takes effect on the next request, but ending the session makes
	// it unmissable for the person whose rights just changed
	if (role !== target.role) revokeSessionsForUser(id, { db });

	recordAudit({
		actorType: 'user',
		actorId,
		action: 'user.set_role',
		targetType: 'user',
		targetId: id,
		ip: options.ip ?? null,
		requestId: options.requestId ?? null,
		meta: { from: target.role, to: role },
		db
	});
	return getUser(id, db) as AdminUserRow;
}

export function setUserStatus(
	id: string,
	status: 'active' | 'disabled',
	options: { actorId?: string | null; ip?: string | null; requestId?: string | null; db?: Db } = {}
): { user: AdminUserRow; sessionsEnded: number } {
	const db = options.db ?? getDb();
	const target = requireUser(id, db);
	const actorId = options.actorId ?? null;

	if (status === 'disabled' && target.role === 'admin' && countActiveAdmins(db) <= 1) {
		throw new RegistryError(
			'last_admin',
			'this is the last active admin; promote someone else first'
		);
	}
	if (status === 'disabled' && target.id === actorId) {
		throw new RegistryError('self_disable', 'you cannot disable your own account');
	}

	db.update(users).set({ status, updatedAt: nowIso() }).where(eq(users.id, id)).run();
	const sessionsEnded = status === 'disabled' ? revokeSessionsForUser(id, { db }) : 0;

	recordAudit({
		actorType: 'user',
		actorId,
		action: status === 'disabled' ? 'user.disable' : 'user.enable',
		targetType: 'user',
		targetId: id,
		ip: options.ip ?? null,
		requestId: options.requestId ?? null,
		meta: { sessionsEnded },
		db
	});
	return { user: getUser(id, db) as AdminUserRow, sessionsEnded };
}

/** Reset another account's password (support flow); revokes its sessions. */
export async function resetUserPassword(
	id: string,
	password: string,
	options: { actorId?: string | null; ip?: string | null; requestId?: string | null; db?: Db } = {}
): Promise<AdminUserRow> {
	const db = options.db ?? getDb();
	requireUser(id, db);
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new RegistryError(
			'weak_password',
			`password must be at least ${MIN_PASSWORD_LENGTH} characters`
		);
	}
	db.update(users)
		.set({
			passwordHash: await hashPassword(password),
			failedAttempts: 0,
			lockedUntil: null,
			updatedAt: nowIso()
		})
		.where(eq(users.id, id))
		.run();
	revokeSessionsForUser(id, { db });

	recordAudit({
		actorType: 'user',
		actorId: options.actorId ?? null,
		action: 'user.reset_password',
		targetType: 'user',
		targetId: id,
		ip: options.ip ?? null,
		requestId: options.requestId ?? null,
		db
	});
	return getUser(id, db) as AdminUserRow;
}

export function countActiveAdmins(db: Db = getDb()): number {
	return db
		.select()
		.from(users)
		.all()
		.filter((row) => row.role === 'admin' && row.status === 'active').length;
}

function requireUser(id: string, db: Db) {
	const row = db.select().from(users).where(eq(users.id, id)).get();
	if (!row) throw new RegistryError('not_found', 'account not found');
	return row;
}
