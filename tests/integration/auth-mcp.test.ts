/**
 * `/mcp` authentication boundary (T-22): status semantics, the per-IP guess
 * backoff, and the freshly-minted-key race that a two-bundle deployment exposes.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpAuthenticator } from '../../src/middleware/auth';
import { createApiKey, hashKey } from '../../src/lib/server/governance/apikey';
import { createProfile } from '../../src/lib/server/registry';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { useDatabaseForTests, getDb } from '../../src/lib/server/db';
import { profiles } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';

const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-auth-mcp-'));
process.env.MCPGW_DATA_DIR = dir;
process.env.MCPGW_MASTER_KEY = '6'.repeat(64);
process.env.MCPGW_PUBLIC_URL = 'https://mcp.test';
runMigrations({ dataDir: dir });
useDatabaseForTests(path.join(dir, 'mcpgw.db'));

const mcpUrl = 'https://mcp.test/mcp';
/** Well-formed shape (prefix + 40..64 base58 chars) but never issued by us. */
const GUESS = `Bearer mcpgw_${'A'.repeat(44)}`;

function request(authorization?: string, origin?: string): Request {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (authorization) headers.set('authorization', authorization);
	if (origin) headers.set('origin', origin);
	return new Request(mcpUrl, { method: 'POST', headers });
}

let clock = 1_000_000;
function authenticator() {
	return createMcpAuthenticator({ now: () => clock });
}

function seedKey(profileName = `profile-${uuidv7().slice(-8)}`) {
	const profile = createProfile({ name: profileName, links: [] });
	const issued = createApiKey({ name: 'k', profileId: profile.id });
	return { profile, ...issued };
}

beforeEach(() => {
	clock += 10 * 60_000; // move past any per-IP backoff from the previous case
});

describe('key states map to statuses', () => {
	test('missing and malformed credentials are 401', async () => {
		const authenticate = authenticator();
		expect((await authenticate(request(), { requestId: 'r', clientAddress: '1.1.1.1' }) as { response: Response }).response.status).toBe(401);
		const bad = await authenticate(request('Bearer nope'), { requestId: 'r', clientAddress: '1.1.1.2' });
		expect((bad as { response: Response }).response.status).toBe(401);
	});

	test('a valid key passes through with caller metadata', async () => {
		const { plaintext, key } = seedKey();
		const result = await authenticator()(request(`Bearer ${plaintext}`), { requestId: 'r1', clientAddress: '2.2.2.2' });
		const caller = result as { apiKeyId: string; profileId: string; requestId: string };
		expect(caller.apiKeyId).toBe(key.id);
		expect(caller.profileId).toBe(key.profileId);
		expect(caller.requestId).toBe('r1');
	});

	test('revoked is 401 and suspended is 403', async () => {
		const { revokeApiKey, suspendApiKey } = await import('../../src/lib/server/governance/apikey');
		const a = seedKey();
		revokeApiKey(a.key.id);
		const revoked = await authenticator()(request(`Bearer ${a.plaintext}`), { requestId: 'r', clientAddress: '3.3.3.1' });
		expect((revoked as { response: Response }).response.status).toBe(401);

		const b = seedKey();
		suspendApiKey(b.key.id);
		const suspended = await authenticator()(request(`Bearer ${b.plaintext}`), { requestId: 'r', clientAddress: '3.3.3.2' });
		expect((suspended as { response: Response }).response.status).toBe(403);
	});

	test('an expired key is 401', async () => {
		const profile = createProfile({ name: `exp-${uuidv7().slice(-8)}`, links: [] });
		const issued = createApiKey({ name: 'exp', profileId: profile.id, expiresAt: isoInThePast() });
		const result = await authenticator()(request(`Bearer ${issued.plaintext}`), { requestId: 'r', clientAddress: '3.3.4.1' });
		expect((result as { response: Response }).response.status).toBe(401);
	});

	test('an IP allowlist refusal is 403, and a listed address passes', async () => {
		const profile = createProfile({ name: `ip-${uuidv7().slice(-8)}`, links: [] });
		const issued = createApiKey({ name: 'ip', profileId: profile.id, ipAllowlist: ['10.0.0.0/8'] });
		const blocked = await authenticator()(request(`Bearer ${issued.plaintext}`), { requestId: 'r', clientAddress: '203.0.113.9' });
		expect((blocked as { response: Response }).response.status).toBe(403);
		const allowed = await authenticator()(request(`Bearer ${issued.plaintext}`), { requestId: 'r', clientAddress: '10.1.2.3' });
		expect((allowed as { apiKeyId?: string }).apiKeyId).toBe(issued.key.id);
	});
});

describe('cache staleness must not look like a bad key', () => {
	test('a key minted by another module instance is accepted immediately', async () => {
		// write directly, bypassing this process's registry cache, to reproduce the
		// two-bundle case (dashboard writes, entrypoint authenticates)
		const db = getDb();
		const profileId = uuidv7();
		db.insert(profiles).values({ id: profileId, name: `cross-${uuidv7().slice(-8)}` }).run();
		const { generatePlaintextKey } = await import('../../src/lib/server/governance/apikey');
		const plaintext = generatePlaintextKey();
		const { apiKeys } = await import('../../src/lib/server/db/schema.ts');
		db.insert(apiKeys)
			.values({
				id: uuidv7(),
				keyHash: hashKey(plaintext),
				keyPrefix: plaintext.slice(0, 10),
				keyTail4: plaintext.slice(-4),
				name: 'external',
				profileId
			})
			.run();
		// deliberately do NOT reload(): the cache in this process has never seen it

		const result = await authenticator()(request(`Bearer ${plaintext}`), { requestId: 'r', clientAddress: '4.4.4.1' });
		expect((result as { apiKeyId?: string }).apiKeyId).toBeDefined();
	});
});

describe('per-IP guess backoff', () => {
	test('ten bad guesses lock that address for a minute', async () => {
		const authenticate = authenticator();
		const base = '9.9.9.9';
		for (let index = 0; index < 10; index += 1) {
			const result = await authenticate(request(GUESS), {
				requestId: 'r',
				clientAddress: base
			});
			expect((result as { response: Response }).response.status).toBe(401);
		}
		const blocked = await authenticate(request(GUESS), {
			requestId: 'r',
			clientAddress: base
		});
		const response = (blocked as { response: Response }).response;
		expect(response.status).toBe(429);
		expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
	});

	test('the backoff is per address, and a real key is never punished', async () => {
		const authenticate = authenticator();
		for (let index = 0; index < 12; index += 1) {
			await authenticate(request(GUESS), {
				requestId: 'r',
				clientAddress: '8.8.8.8'
			});
		}
		const { plaintext } = seedKey();
		const other = await authenticate(request(`Bearer ${plaintext}`), { requestId: 'r', clientAddress: '7.7.7.7' });
		expect((other as { apiKeyId?: string }).apiKeyId).toBeDefined();
	});

	test('revoked and expired keys do not burn the source address', async () => {
		const { revokeApiKey } = await import('../../src/lib/server/governance/apikey');
		const authenticate = authenticator();
		const address = '6.6.6.6';
		for (let index = 0; index < 12; index += 1) {
			const issued = seedKey(`burn-${index}-${uuidv7().slice(-6)}`);
			revokeApiKey(issued.key.id);
			const result = await authenticate(request(`Bearer ${issued.plaintext}`), { requestId: 'r', clientAddress: address });
			expect((result as { response: Response }).response.status).toBe(401);
		}
		// a genuinely bad guess afterwards must still be a 401, not a locked 429
		const bad = await authenticate(request(GUESS), {
			requestId: 'r',
			clientAddress: address
		});
		expect((bad as { response: Response }).response.status).toBe(401);
	});
});

describe('budgets and origin', () => {
	test('an exhausted request budget is 429 with Retry-After', async () => {
		const profile = createProfile({ name: `rl-${uuidv7().slice(-8)}`, links: [], rateLimitRpm: 3 });
		const issued = createApiKey({ name: 'rl', profileId: profile.id });
		const authenticate = authenticator();
		const statuses: number[] = [];
		for (let index = 0; index < 8; index += 1) {
			const result = await authenticate(request(`Bearer ${issued.plaintext}`), { requestId: 'r', clientAddress: '5.5.5.5' });
			const response = (result as { response?: Response }).response;
			statuses.push(response ? response.status : 200);
			if (response && response.status === 429) {
				expect(response.headers.get('retry-after')).not.toBeNull();
				expect(response.headers.get('x-ratelimit-remaining')).toBe('0');
			}
		}
		expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
	});

	test('a foreign browser Origin is refused before any key lookup', async () => {
		const authenticate = authenticator();
		const result = await authenticate(request(GUESS, 'https://evil.example'), {
			requestId: 'r',
			clientAddress: '5.5.6.1'
		});
		const response = (result as { response: Response }).response;
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: 'forbidden_origin' });
	});
});

function isoInThePast(): string {
	return new Date(Date.now() - 60_000).toISOString();
}

describe('cleanup', () => {
	test('fixture directory is removed', () => {
		rmSync(dir, { recursive: true, force: true });
	});
});
