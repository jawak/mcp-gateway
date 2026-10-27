import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isRedirect } from '@sveltejs/kit';
import { resetConfigCache } from '../../src/lib/server/config';
import { getDb, useDatabaseForTests, type Db } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { users } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import { createUpstream, ensureLoaded } from '../../src/lib/server/registry';
import { listAudit } from '../../src/lib/server/observability/audit';
import { logger } from '../../src/lib/server/observability/logger';
import { redactValue } from '../../src/lib/server/security/redact';
import { getOAuthConfig, upsertOAuthConfig } from '../../src/lib/server/upstream/oauth/store';
import { actions } from '../../src/routes/admin/upstreams/[slug]/+page.server';

const PUBLIC_URL = 'https://gateway.example.test';
const ADMIN_EMAIL = 'admin@example.test';

const TOKEN_SENTINEL = 'SENTINEL-ACCESS-TOKEN-4e8f';
const CODE_SENTINEL = 'SENTINEL-AUTH-CODE-9f3a';
const VERIFIER_SENTINEL = 'SENTINEL-CODE-VERIFIER-5d6e';
const REGISTRATION_FAILURE =
	`registration failed: error=invalid_grant` +
	`&access_token=${TOKEN_SENTINEL}&code=${CODE_SENTINEL}&code_verifier=${VERIFIER_SENTINEL}`;
const SENTINELS = [TOKEN_SENTINEL, CODE_SENTINEL, VERIFIER_SENTINEL];

let dir: string;
let db: Db;
let adminId: string;

const admin = {
	user: { id: '', email: ADMIN_EMAIL, role: 'admin' as const, status: 'active' as const },
	sessionId: null
};

function createUser(email: string): string {
	const id = uuidv7();
	db.insert(users)
		.values({ id, email, passwordHash: 'synthetic-not-a-real-hash', role: 'admin' })
		.run();
	return id;
}

function seedOAuthUpstream(url: string): { id: string; slug: string } {
	const slug = `dd-redact-${uuidv7().slice(-8)}`;
	const created = createUpstream(
		{ slug, name: 'Datadog', transport: 'http', connection: { url, authMode: 'oauth' } },
		db
	);
	upsertOAuthConfig(created.id, { status: 'disconnected', scopes: 'mcp_all' }, db);
	return { id: created.id, slug: created.slug };
}

async function callOAuthStart(slug: string): Promise<unknown> {
	const request = new Request(`http://localhost/admin/upstreams/${slug}?/oauthStart`, {
		method: 'POST',
		body: new FormData()
	});
	try {
		return await actions.oauthStart({
			params: { slug },
			request,
			locals: admin,
			getClientAddress: () => '203.0.113.10'
		} as never);
	} catch (thrown) {
		return thrown;
	}
}

function startFailingAuthServer(): { origin: string; stop(): void } {
	let origin = '';
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
				return new Response('not found', { status: 404 });
			}
			if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
				return Response.json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ['code'],
					grant_types_supported: ['authorization_code', 'refresh_token'],
					code_challenge_methods_supported: ['S256'],
					token_endpoint_auth_methods_supported: ['none'],
					scopes_supported: ['mcp_all']
				});
			}
			if (url.pathname === '/register') {
				return Response.json(
					{ error: 'invalid_client_metadata', error_description: REGISTRATION_FAILURE },
					{ status: 400 }
				);
			}
			return new Response('not found', { status: 404 });
		}
	});
	origin = `http://127.0.0.1:${server.port as number}`;
	return { origin, stop: () => server.stop(true) };
}

async function captureLogLine(emit: () => void): Promise<string> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		emit();
		await Bun.sleep(10);
	} finally {
		process.stdout.write = original;
	}
	return chunks.join('');
}

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-oauth-redaction-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = '99'.repeat(32);
	process.env.MCPGW_PUBLIC_URL = PUBLIC_URL;
	resetConfigCache();
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	db = getDb();
	ensureLoaded(db);
	adminId = createUser(ADMIN_EMAIL);
	admin.user.id = adminId;
});

afterAll(() => {
	resetConfigCache();
	rmSync(dir, { recursive: true, force: true });
});

describe('OAuth failure redaction', () => {
	test('the generic failure path never stores or logs token, code, or verifier material', async () => {
		const fake = startFailingAuthServer();
		try {
			const upstream = seedOAuthUpstream(`${fake.origin}/mcp`);
			const thrown = await callOAuthStart(upstream.slug);

			expect(isRedirect(thrown)).toBe(true);
			const redirect = thrown as { status: number; location: string };
			expect(redirect.status).toBe(303);

			const location = new URL(redirect.location, PUBLIC_URL);
			expect(location.pathname).toBe(`/admin/upstreams/${upstream.slug}`);
			expect([...location.searchParams.keys()]).toEqual(['oauthError']);
			expect(location.searchParams.get('oauthError')).toBe('oauth_failed');
			for (const sentinel of SENTINELS) {
				expect(redirect.location).not.toContain(sentinel);
			}
			expect(redirect.location).not.toContain(fake.origin);

			const oauth = getOAuthConfig(upstream.id);
			expect(oauth?.status).toBe('error');
			expect(oauth?.lastError).toContain('[redacted]');
			expect(oauth?.lastError).toContain('invalid_grant');
			for (const sentinel of SENTINELS) {
				expect(oauth?.lastError).not.toContain(sentinel);
			}

			const audits = listAudit({ targetId: upstream.id });
			const serializedAudits = JSON.stringify(audits);
			for (const sentinel of SENTINELS) {
				expect(serializedAudits).not.toContain(sentinel);
			}
			const failure = listAudit({ action: 'oauth.connect.failure', targetId: upstream.id });
			expect(failure).toHaveLength(1);
			expect(failure[0]?.meta).toEqual({ code: 'oauth_failed' });
			expect(failure[0]?.actorId).toBe(adminId);

			const logLine = await captureLogLine(() => {
				logger.info(
					redactValue({ event: 'oauth.connect.failure', error: REGISTRATION_FAILURE }),
					'oauth connect failure'
				);
			});
			expect(logLine).toContain('[redacted]');
			expect(logLine).toContain('invalid_grant');
			for (const sentinel of SENTINELS) {
				expect(logLine).not.toContain(sentinel);
			}
		} finally {
			fake.stop();
		}
	});
});
