/**
 * Password hashing (T-04: needed by the admin bootstrap in `db/seed.ts`;
 * full security module lands in T-05).
 *
 * argon2id per OWASP: 19 MiB memory would be the sweet spot but the gateway
 * also runs on 512 MB VPS boxes, so we use the OWASP "preferred" alternative
 * (64 MiB, t=3, p=4) which is still comfortably above the minimum.
 * `verifySafe` runs a dummy hash for unknown users so a login attempt cannot
 * be answered faster by an unrecognised email (timing oracle).
 */
import argon2 from 'argon2';

const OPTIONS = {
	type: argon2.argon2id,
	memoryCost: 65_536, // KiB → 64 MiB
	timeCost: 3,
	parallelism: 4
} as const;

/**
 * Timing pad for unknown users: a real hash computed once per process over a
 * throwaway secret, so a failed login costs the same as a successful one.
 */
let dummyHash: Promise<string> | undefined;
function pad(): Promise<string> {
	dummyHash ??= argon2.hash(crypto.randomUUID(), OPTIONS);
	return dummyHash;
}

/**
 * One place defines the policy; `hashPassword` enforces it for every caller
 * (bootstrap, dashboard, CLI), so a rule can never be weaker on one path than
 * another.
 */
export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
	}
	return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
	try {
		return await argon2.verify(hash, password);
	} catch {
		// malformed/truncated hash or unsupported parameters
		return false;
	}
}

/** Always spends ~one hash worth of time, whether or not the user exists. */
export async function verifySafe(hash: string | undefined, password: string): Promise<boolean> {
	if (!hash) {
		await argon2.verify(await pad(), password).catch(() => false);
		return false;
	}
	return verifyPassword(hash, password);
}

/** True when stored parameters are weaker than the current policy. */
export function needsRehash(hash: string): boolean {
	try {
		return argon2.needsRehash(hash, OPTIONS);
	} catch {
		return true;
	}
}
