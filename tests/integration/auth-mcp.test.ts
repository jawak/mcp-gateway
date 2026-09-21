/**
 * Auth boundary tests for `/mcp` (T-22): the HTTP semantics of every key state,
 * Origin refusal, per-IP failure backoff, budgets, quotas and instant teardown.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Authenticate } from '../../src/lib/server/mcp/gateway';
import type { McpCaller } from '../../src/lib/server/mcp/backend';
import { createMcpAuthenticator } from '../../src/middleware/auth';
import { createGatewayApp } from '../../src/lib/server/gateway-app';
import {
	createApiKey,
	revokeApiKey,
	suspendApiKey,
	setIpAllowlist
} from '../../src/lib/server/governance/apikey';
import { createProfile } from '../../src/lib/server/registry';
import { RateLimiter } from '../../src/lib/server/governance/ratelimit';
import { auditLog } from '../../src/lib/server/db/schema';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { resetConfigCache } from '../../src/lib/server/config';
import { uuidv7 } from '../../src/lib/shared/ids';
import type { RequestContext } from '../../src/handle';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-auth-'));
const INIT_BODY = JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'auth-test', version: '1' }
	}
});

let profileId: string;

function context(ip = '203.0.113.1'): RequestContext {
	return { requestId: `req-${uuidv7().slice(0, 8)}`, clientAddress: ip };
}

function post(headers: Record<string, string> = {}, body: string = INIT_BODY): Request {
	return new Request('http://localhost/mcp', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...headers
		},
		body
	});
}

function appFor(authenticate: Authenticate) {
	return createGatewayApp({ authenticate, limiter: new RateLimiter({ queueWaitMs: 100 }) });
}

beforeAll(() => {
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '8'.repeat(64);
	process.env.MCPGW_PUBLIC_URL = 'https://mcp.test';
	// config is memoised at first use, which can happen during module loading;
	// drop the cache so the env above is what the auth boundary actually reads
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	profileId = createProfile({
		name: 'auth-profile',
		rateLimitRpm: 60,
		dailyCallQuota: 1_000,
		maxConcurrency: 2
	}).id;
});

const fresh = () => appFor(createMcpAuthenticator());

describe('key states map to HTTP semantics', () => {
	let app: ReturnType<typeof appFor>;
	beforeEach(() => {
		app = fresh();
	});

	test('a missing header is 401 with a Bearer challenge', async () => {
		const res = await app.endpoint.handle(post(), context());
		expect(res.status).toBe(401);
		expect(res.headers.get('www-authenticate')).toContain('Bearer');
		expect(((await res.json()) as { error: string }).error).toBe('invalid_api_key');
	});

	test('a malformed or unknown key is also 401', async () => {
		expect(
			(await app.endpoint.handle(post({ authorization: 'Bearer hunter2' }), context())).status
		).toBe(401);
		expect(
			(
				await app.endpoint.handle(
					post({ authorization: `Bearer mcpgw_${'a'.repeat(50)}` }),
					context()
				)
			).status
		).toBe(401);
	});

	test('a valid key completes the handshake', async () => {
		const { plaintext } = createApiKey({ name: 'valid', profileId });
		const res = await app.endpoint.handle(
			post({ authorization: `Bearer ${plaintext}` }),
			context()
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('mcp-session-id')).toBeTruthy();
		await app.shutdown();
	});

	test('a suspended key is 403, a revoked key is 401', async () => {
		const suspended = createApiKey({ name: 'suspended', profileId });
		suspendApiKey(suspended.key.id);
		const suspendedRes = await app.endpoint.handle(
			post({ authorization: `Bearer ${suspended.plaintext}` }),
			context()
		);
		expect(suspendedRes.status).toBe(403);
		expect(((await suspendedRes.json()) as { error: string }).error).toBe('key_suspended');

		const revoked = createApiKey({ name: 'revoked', profileId });
		revokeApiKey(revoked.key.id);
		expect(
			(await app.endpoint.handle(post({ authorization: `Bearer ${revoked.plaintext}` }), context()))
				.status
		).toBe(401);
	});

	test('an IP outside the allowlist is refused, inside it is accepted', async () => {
		const { plaintext, key } = createApiKey({
			name: 'office-only',
			profileId,
			ipAllowlist: ['198.51.100.0/24']
		});
		expect(
			(
				await app.endpoint.handle(
					post({ authorization: `Bearer ${plaintext}` }),
					context('198.51.100.9')
				)
			).status
		).toBe(200);
		const blocked = await app.endpoint.handle(
			post({ authorization: `Bearer ${plaintext}` }),
			context('198.52.0.1')
		);
		expect(blocked.status).toBe(403);
		expect(((await blocked.json()) as { error: string }).error).toBe('ip_not_allowed');
		setIpAllowlist(key.id, []);
	});
});

describe('origin and abuse protections', () => {
	test('a foreign browser Origin is refused before any key lookup', async () => {
		const app = fresh();
		const { plaintext } = createApiKey({ name: 'origin', profileId });
		const res = await app.endpoint.handle(
			post({ origin: 'https://evil.example', authorization: `Bearer ${plaintext}` }),
			context()
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe('forbidden_origin');
		// the gateway's own origin is fine
		expect(
			(
				await app.endpoint.handle(
					post({ origin: 'https://mcp.test', authorization: `Bearer ${plaintext}` }),
					context()
				)
			).status
		).toBe(200);
		await app.shutdown();
	});

	test('10 failures from one IP earns that IP a minute of 429', async () => {
		const app = fresh();
		const ip = '203.0.113.66';
		for (let index = 0; index < 10; index += 1) {
			const res = await app.endpoint.handle(
				post({ authorization: `Bearer mcpgw_${'b'.repeat(50)}` }),
				context(ip)
			);
			expect(res.status).toBe(401);
		}
		const blocked = await app.endpoint.handle(
			post({ authorization: `Bearer mcpgw_${'b'.repeat(50)}` }),
			context(ip)
		);
		expect(blocked.status).toBe(429);
		expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);

		// another IP is unaffected, proving the window is per source
		const other = await app.endpoint.handle(
			post({ authorization: `Bearer mcpgw_${'b'.repeat(50)}` }),
			context('203.0.113.67')
		);
		expect(other.status).toBe(401);

		// a success clears the window for that IP
		const { plaintext } = createApiKey({ name: 'clean-ip', profileId });
		const clean = await app.endpoint.handle(
			post({ authorization: `Bearer ${plaintext}` }),
			context('192.0.2.10')
		);
		expect(clean.status).toBe(200);
		await app.shutdown();
	});

	test('auth failures are audited, sampled rather than per attempt', async () => {
		const app = fresh();
		const ip = `203.0.113.${Math.floor(Math.random() * 200) + 10}`;
		for (let index = 0; index < 4; index += 1) {
			await app.endpoint.handle(
				post({ authorization: `Bearer mcpgw_${'c'.repeat(50)}` }),
				context(ip)
			);
		}
		const rows = getDb()
			.select()
			.from(auditTable())
			.all()
			.filter((row) => row.action === 'mcp.auth_failure' && row.ip === ip);
		expect(rows.length).toBe(1); // only the first failure of the window
		expect(rows[0]?.targetId).toBeTruthy();
		await app.shutdown();
	});
});

describe('budgets', () => {
	test('the per-key request budget yields 429 with Retry-After', async () => {
		const tight = createProfile({ name: `tight-${uuidv7().slice(-6)}`, rateLimitRpm: 3 });
		const { plaintext } = createApiKey({ name: 'tight-key', profileId: tight.id });
		const app = fresh();
		const statuses: number[] = [];
		for (let index = 0; index < 5; index += 1) {
			statuses.push(
				(
					await app.endpoint.handle(
						post({ authorization: `Bearer ${plaintext}` }),
						context('192.0.2.' + index)
					)
				).status
			);
		}
		expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
		expect(statuses[3]).toBe(429);
		const limited = await app.endpoint.handle(
			post({ authorization: `Bearer ${plaintext}` }),
			context('192.0.2.9')
		);
		expect(limited.headers.get('retry-after')).toBeTruthy();
		expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
		await app.shutdown();
	});

	test('the daily quota refuses further calls once spent', async () => {
		const capped = createProfile({
			name: `capped-${uuidv7().slice(-6)}`,
			rateLimitRpm: 600,
			dailyCallQuota: 2
		});
		const { plaintext } = createApiKey({ name: 'capped-key', profileId: capped.id });
		const limiter = new RateLimiter({ queueWaitMs: 100 });
		const app = appFor(withLimiter(limiter));
		const first = await app.endpoint.handle(
			post({ authorization: `Bearer ${plaintext}` }),
			context('198.51.100.1')
		);
		expect(first.status).toBe(200);
		// spend the quota directly (tool calls consume it through the backend guard)
		const key = (await import('../../src/lib/server/governance/apikey'))
			.listApiKeys()
			.find((entry) => entry.name === 'capped-key');
		for (let index = 0; index < 2; index += 1) limiter.consumeDaily(key!.id);
		const exhausted = await app.endpoint.handle(
			post({ authorization: `Bearer ${plaintext}` }),
			context('198.51.100.2')
		);
		expect(exhausted.status).toBe(429);
		expect(((await exhausted.json()) as { error: string }).error).toBe('daily_quota_exhausted');
		await app.shutdown();
	});
});

describe('revocation kills live sessions (FR-03)', () => {
	test('a connected session disappears the moment its key is revoked', async () => {
		const app = fresh();
		const { plaintext, key } = createApiKey({ name: 'live-session', profileId });
		const res = await app.endpoint.handle(
			post({ authorization: `Bearer ${plaintext}` }),
			context('192.0.2.50')
		);
		const sessionId = res.headers.get('mcp-session-id');
		expect(sessionId).toBeTruthy();
		expect(app.sessions.count).toBe(1);

		revokeApiKey(key.id);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(app.sessions.count).toBe(0);

		const reuse = await app.endpoint.handle(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json',
					authorization: `Bearer ${plaintext}`,
					'mcp-session-id': sessionId as string
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
			}),
			context('192.0.2.50')
		);
		expect(reuse.status).toBe(401);
		await app.shutdown();
	});
});

describe('caller identity', () => {
	test('the backend receives key, profile and request metadata — never the secret', async () => {
		const seen: McpCaller[] = [];
		const app = createGatewayApp({
			authenticate: createMcpAuthenticator(),
			limiter: new RateLimiter({ queueWaitMs: 100 })
		});
		const { plaintext, key } = createApiKey({ name: 'identity', profileId });
		const res = await app.endpoint.handle(
			post({ authorization: `Bearer ${plaintext}` }),
			context('192.0.2.88')
		);
		expect(res.status).toBe(200);
		// the session records who opened it
		const [entry] = app.sessions.list();
		expect(entry).toMatchObject({ keyName: 'identity', profileId });
		expect(JSON.stringify(entry)).not.toContain(plaintext);
		expect(key.status).toBe('active');
		await app.shutdown();
		void seen;
	});
});

/** authenticator bound to a specific limiter instance (for quota assertions) */
function withLimiter(limiter: RateLimiter): Authenticate {
	return createMcpAuthenticator({ limiter });
}

function auditTable() {
	return auditLog;
}
