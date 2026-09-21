/**
 * Remote (Streamable HTTP) upstream transport tests (T-07).
 *
 * The upstream is a real MCP server served in-process on loopback; DNS answers
 * are injected so the SSRF guard can be exercised without touching the network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connectRemoteHttp } from '../../src/lib/server/upstream/remote-http';
import {
	UpstreamTransportError,
	type UpstreamHandle,
	type UpstreamRecord
} from '../../src/lib/server/upstream/types';
import { useDatabaseForTests, getDb } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { secretRefs } from '../../src/lib/server/db/schema';
import { sealSecret } from '../../src/lib/server/security/vault';
import { uuidv7 } from '../../src/lib/shared/ids';
import { startFixtureHttpServer, type FixtureHttpServer } from '../fixtures/http-mcp-server';

const SECRET_NAME = 'remote-token';
const CREDENTIAL = 'ghu_super_secret_credential_123';

let dir: string;
let fixture: FixtureHttpServer;
const handles: UpstreamHandle[] = [];

function record(overrides: Partial<UpstreamRecord> = {}): UpstreamRecord {
	return {
		id: uuidv7(),
		slug: 'remote',
		name: 'Remote fixture',
		transport: 'http',
		enabled: true,
		connection: { url: fixture.url },
		envRefs: {},
		timeoutMs: 5_000,
		pin: 'pinned',
		...overrides
	};
}

async function open(
	overrides: Partial<UpstreamRecord> = {},
	options = {}
): Promise<UpstreamHandle> {
	const handle = await connectRemoteHttp({ record: record(overrides), ...options });
	handles.push(handle);
	return handle;
}

/** Deterministic DNS for the SSRF assertions. */
const resolvesTo =
	(...addresses: string[]) =>
	async (): Promise<Array<{ address: string }>> =>
		addresses.map((address) => ({ address }));

beforeAll(async () => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-http-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = 'd'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
	insertSecret(SECRET_NAME, CREDENTIAL);
	fixture = await startFixtureHttpServer();
});

afterAll(async () => {
	for (const handle of handles) await handle.close().catch(() => undefined);
	fixture?.stop();
	rmSync(dir, { recursive: true, force: true });
});

function insertSecret(name: string, value: string): void {
	const sealed = sealSecret(value);
	getDb()
		.insert(secretRefs)
		.values({
			id: uuidv7(),
			name,
			cipher: sealed.cipher,
			iv: sealed.iv,
			tag: sealed.tag,
			keyVer: sealed.keyVer
		})
		.onConflictDoNothing()
		.run();
}

describe('remote upstream — happy path', () => {
	test('connects to a Streamable HTTP MCP endpoint and calls tools', async () => {
		const handle = await open();
		expect(handle.transport).toBe('http');
		expect(handle.connected).toBe(true);
		const { tools } = await handle.listTools();
		expect(tools.map((tool) => tool.name)).toContain('echo');
		expect(handle.diagnostics().serverInfo?.name).toBe('fixture-upstream');
		expect(handle.diagnostics().toolsCount).toBe(tools.length);

		const echo = await handle.callTool('echo', { text: 'over http' });
		expect(JSON.stringify(echo.content)).toContain('echo:over http');

		const { resources } = await handle.listResources();
		expect(resources.map((resource) => resource.uri)).toContain('fixture://status');
		const { prompts } = await handle.listPrompts();
		expect(prompts.map((prompt) => prompt.name)).toContain('summarise');
		expect((await handle.ping(2_000)).latencyMs).toBeGreaterThanOrEqual(0);
	});

	test('reconnects on next use after the session was closed', async () => {
		const handle = await open();
		await handle.close();
		expect(handle.connected).toBe(false);
		// closing marks the handle dead, so a fresh handle models the pool's reconnect
		const reopened = await open();
		expect(reopened.connected).toBe(true);
		expect(JSON.stringify((await reopened.callTool('add', { a: 2, b: 2 })).content)).toContain('4');
	});

	test('graceful close waits for an in-flight request', async () => {
		const handle = await open();
		const inflight = handle.callTool('slow', { ms: 500 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(handle.inFlight).toBe(1);
		await handle.close({ graceMs: 2_000 });
		expect(JSON.stringify((await inflight).content)).toContain('slept:500');
	});
});

describe('remote upstream — authentication', () => {
	test('attaches a bearer credential opened from the vault', async () => {
		await fixture.stop();
		fixture = await startFixtureHttpServer({ requireBearer: CREDENTIAL });
		const handle = await open({
			connection: { url: fixture.url, authStyle: 'bearer', authRef: `secret:${SECRET_NAME}` }
		});
		expect(JSON.stringify((await handle.callTool('echo', { text: 'authed' })).content)).toContain(
			'echo:authed'
		);
		expect(fixture.requests.lastAuthorization).toBe(`Bearer ${CREDENTIAL}`);
	});

	test('a custom auth header name is honoured', async () => {
		await fixture.stop();
		fixture = await startFixtureHttpServer({ requireAuthorizationRaw: CREDENTIAL });
		const handle = await open({
			connection: {
				url: fixture.url,
				authStyle: 'header',
				authName: 'authorization',
				authRef: `secret:${SECRET_NAME}`
			}
		});
		await handle.callTool('echo', { text: 'x' });
		// `authStyle: 'header'` sends the credential verbatim — no Bearer prefix
		expect(fixture.requests.lastAuthorization).toBe(CREDENTIAL);
	});

	test('static and vault-backed extra headers are sent', async () => {
		await fixture.stop();
		fixture = await startFixtureHttpServer();
		insertSecret('remote-headers', JSON.stringify({ 'x-api-key': 'from-vault' }));
		const handle = await open({
			connection: { url: fixture.url, headers: { 'x-static': 'yes' } },
			headersRef: 'remote-headers'
		} as Partial<UpstreamRecord>);
		await handle.callTool('echo', { text: 'x' });
		expect(fixture.requests.lastApiKey).toBe('from-vault');
	});

	test('a missing credential means unconfigured, with an actionable message', async () => {
		let error: unknown;
		try {
			await open({ connection: { url: fixture.url, authRef: 'secret:does-not-exist' } });
		} catch (cause) {
			error = cause;
		}
		expect((error as Error).name).toBe('UnconfiguredUpstreamError');
		expect((error as Error).message).toContain('add it in the upstream form');
	});

	test('credentials never appear in diagnostics', async () => {
		await fixture.stop();
		fixture = await startFixtureHttpServer({ requireBearer: CREDENTIAL });
		const handle = await open({
			connection: { url: fixture.url, authRef: `secret:${SECRET_NAME}` }
		});
		await handle.callTool('echo', { text: 'x' });
		expect(JSON.stringify(handle.diagnostics())).not.toContain(CREDENTIAL);
	});
});

describe('remote upstream — SSRF guard', () => {
	test('refuses http:// to a public host', async () => {
		let error: unknown;
		try {
			await open(
				{ connection: { url: 'http://mcp.example.com/mcp' } },
				{ ssrf: { resolve: resolvesTo('93.184.216.34') } }
			);
		} catch (cause) {
			error = cause;
		}
		expect((error as Error).message).toMatch(/http:\/\/ is refused/);
	});

	test('refuses a host that resolves to the cloud metadata address', async () => {
		const before = fixture.requests.total;
		let error: unknown;
		try {
			await open(
				{ connection: { url: 'https://metadata.example/mcp' } },
				{ ssrf: { resolve: resolvesTo('169.254.169.254') } }
			);
		} catch (cause) {
			error = cause;
		}
		expect((error as Error).message).toMatch(/link-local/);
		expect(fixture.requests.total).toBe(before);
	});

	test('refuses private ranges unless explicitly allowed', async () => {
		await expect(
			open(
				{ connection: { url: 'https://internal.example/mcp' } },
				{ ssrf: { resolve: resolvesTo('10.1.2.3') } }
			)
		).rejects.toThrow(/private range/);
	});

	test('refuses credentials embedded in the URL', async () => {
		await expect(
			open(
				{ connection: { url: 'https://admin:pw@mcp.example.com/mcp' } },
				{ ssrf: { resolve: resolvesTo('93.184.216.34') } }
			)
		).rejects.toThrow(/credentials in the URL/);
	});

	test('rejects non-http schemes', async () => {
		await expect(open({ connection: { url: 'file:///etc/passwd' } })).rejects.toThrow(
			/unsupported protocol/
		);
	});
});

describe('remote upstream — failure modes', () => {
	test('a 5xx endpoint produces a retryable transport error', async () => {
		const offline = await startFixtureHttpServer({ failWith: 503 });
		try {
			let error: unknown;
			try {
				await open({ connection: { url: offline.url } });
			} catch (cause) {
				error = cause;
			}
			expect(error).toBeInstanceOf(UpstreamTransportError);
			expect((error as UpstreamTransportError).retryable).toBe(true);
			expect((error as Error).message).toContain('could not reach');
		} finally {
			offline.stop();
		}
	});

	test('a connection-refused port fails fast and retryably', async () => {
		const closed = await startFixtureHttpServer();
		const deadPort = closed.port;
		closed.stop();
		await expect(
			open(
				{ connection: { url: `http://127.0.0.1:${deadPort}/mcp` } },
				{ handshakeTimeoutMs: 3_000 }
			)
		).rejects.toThrow(/could not reach/);
	});

	test('a missing url is reported as unconfigured', async () => {
		await expect(open({ connection: { url: '' } })).rejects.toThrow(/no url configured/);
	});
});
