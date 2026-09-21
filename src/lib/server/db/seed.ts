/**
 * First-run admin bootstrap (T-04).
 *
 * Idempotent: safe to run on every boot. Rules:
 *  - nothing happens unless both MCPGW_ADMIN_EMAIL and MCPGW_ADMIN_PASSWORD are set;
 *  - a too-weak password is reported, never retried silently and never fatal: it is a
 *    bootstrap input, and a bad one must not stop the *gateway* from starting (that
 *    used to surface as an unrelated ConfigError from the whole-process validator,
 *    which also broke the worker — a value only used here should not be able to do
 *    that). `hashPassword` remains the enforcement point for every other caller;
 *  - the account is created when missing, and the very first admin is never
 *    demoted or disabled by later UI actions (guard lives in `governance`);
 *  - an existing account is never overwritten with a new password, because the
 *    env var is usually left in place long after the operator changed it.
 */
import { count, eq } from 'drizzle-orm';
import { uuidv7 } from '../../shared/ids.ts';
import { nowIso } from '../../shared/time.ts';
import { getConfig } from '../config.ts';
import { getDb, type Db } from './index.ts';
import { users } from './schema.ts';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../security/password.ts';
import { logger } from '../observability/logger.ts';

const log = logger.child({ component: 'seed' });

export type SeedResult = { created: boolean; reason: string; email?: string };

export async function seedAdmin(db: Db = getDb()): Promise<SeedResult> {
	const { admin } = getConfig();
	if (!admin.email || !admin.password) {
		return { created: false, reason: 'MCPGW_ADMIN_EMAIL/MCPGW_ADMIN_PASSWORD not set' };
	}
	if (admin.password.length < MIN_PASSWORD_LENGTH) {
		const reason = `MCPGW_ADMIN_PASSWORD is too short — use at least ${MIN_PASSWORD_LENGTH} characters`;
		log.warn(
			{ minLength: MIN_PASSWORD_LENGTH },
			'skipped the admin bootstrap: weak bootstrap password'
		);
		return { created: false, reason };
	}

	const email = admin.email.toLowerCase();
	const existing = db.select().from(users).where(eq(users.email, email)).get();
	if (existing) {
		return { created: false, reason: 'account already exists', email };
	}

	const [{ value: total }] = db.select({ value: count() }).from(users).all();
	const createdAt = nowIso();
	db.insert(users)
		.values({
			id: uuidv7(),
			email,
			passwordHash: await hashPassword(admin.password),
			role: 'admin',
			status: 'active',
			createdAt,
			updatedAt: createdAt
		})
		.run();

	return {
		created: true,
		reason:
			total === 0 ? 'bootstrap admin (first user)' : 'bootstrap admin (recovery: no admin exists)',
		email
	};
}

/**
 * Warn about the one state that looks healthy but is a dead end: the gateway is
 * running and the dashboard renders, yet nobody can sign in.
 */
export function warnIfNoAccounts(db: Db = getDb()): boolean {
	const [{ value: total }] = db.select({ value: count() }).from(users).all();
	if (total === 0) {
		log.warn(
			`no admin account exists — set MCPGW_ADMIN_EMAIL and a MCPGW_ADMIN_PASSWORD of at least ${MIN_PASSWORD_LENGTH} characters, then restart`
		);
	}
	return total === 0;
}
