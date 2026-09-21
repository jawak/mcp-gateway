/**
 * First-run admin bootstrap (T-04).
 *
 * Idempotent: safe to run on every boot. Rules:
 *  - nothing happens unless both MCPGW_ADMIN_EMAIL and MCPGW_ADMIN_PASSWORD are set;
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
import { hashPassword } from '../security/password.ts';

export type SeedResult = { created: boolean; reason: string; email?: string };

export async function seedAdmin(db: Db = getDb()): Promise<SeedResult> {
	const { admin } = getConfig();
	if (!admin.email || !admin.password) {
		return { created: false, reason: 'MCPGW_ADMIN_EMAIL/MCPGW_ADMIN_PASSWORD not set' };
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
