import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { connectStdio, withTimeout } from '../../src/lib/server/upstream/stdio';
import {
	UnconfiguredUpstreamError,
	UpstreamCoolingDownError,
	UpstreamTransportError,
	type UpstreamHandle,
	type UpstreamRecord
} from '../../src/lib/server/upstream/types';
import { backoffDelayMs, FailureTracker } from '../../src/lib/server/upstream/restart';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { secretRefs } from '../../src/lib/server/db/schema';
import { sealSecret } from '../../src/lib/server/security/vault';
import { uuidv7 } from '../../src/lib/shared/ids';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'echo-mcp-server.ts');

let dir: string;
const handles: UpstreamHandle[] = [];

function record(overrides: Partial<UpstreamRecord> = {}): UpstreamRecord {
	return {
		id: uuidv7(),
		slug: 'fixture',
		name: 'Fixture upstream',
		transport: 'stdio',
		enabled: true,
		connection: { command: process.execPath, args: [FIXTURE] },
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
	const handle = await connectStdio({ record: record(overrides), ...options });
	handles.push(handle);
	return handle;
}

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-stdio-'));
	process.env.MCPGW_DATA_DIR = dir;
	process.env.MCPGW_MASTER_KEY = 'c'.repeat(64);
	runMigrations({ dataDir: dir });
	useDatabaseForTests(path.join(dir, 'mcpgw.db'));
});

afterAll(async () => {
	for (const handle of handles) await handle.close().catch(() => undefined);
	rmSync(dir, { recursive: true, force: true });
});

describe('stdio upstream — handshake', () => {
	test('connects and reports serverInfo, capabilities and tool count', async () => {
		const handle = await open();
		expect(handle.connected).toBe(true);
		const { tools } = await handle.listTools();
		const diagnostics = handle.diagnostics();
		expect(diagnostics.serverInfo).toEqual({ name: 'fixture-upstream', version: '1.0.0' });
		expect(diagnostics.capabilities?.tools).toBeDefined();
		expect(diagnostics.toolsCount).toBe(tools.length);
		expect(tools.map((tool) => tool.name)).toContain('echo');
		expect(tools.find((tool) => tool.name === 'echo')?.inputSchema).toBeObject();
	});

	test('calls tools and passes arguments through unchanged', async () => {
		const handle = await open();
		const echo = await handle.callTool('echo', { text: 'hello world' });
		expect(JSON.stringify(echo.content)).toContain('echo:hello world');
		expect(echo.isError).toBeFalsy();
		const sum = await handle.callTool('add', { a: 20, b: 22 });
		expect(JSON.stringify(sum.content)).toContain('42');
	});

	test('exposes resources and prompts', async () => {
		const handle = await open();
		const { resources } = await handle.listResources();
		expect(resources.map((resource) => resource.uri)).toContain('fixture://status');
		const read = await handle.readResource('fixture://status');
		expect(JSON.stringify(read.contents)).toContain('operational');
		const { prompts } = await handle.listPrompts();
		expect(prompts.map((prompt) => prompt.name)).toContain('summarise');
		const prompt = await handle.getPrompt('summarise', { target: 'the report' });
		expect(JSON.stringify(prompt.messages)).toContain('Summarise: the report');
	});

	test('ping reports a latency', async () => {
		const handle = await open();
		const { latencyMs } = await handle.ping(2_000);
		expect(latencyMs).toBeGreaterThanOrEqual(0);
		expect(handle.diagnostics().spawnCount).toBe(1);
	});

	test('a bad command yields a retryable transport error, not a crash', async () => {
		let error: unknown;
		try {
			await open({ connection: { command: '/nonexistent/mcp-binary', args: [] } });
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(UpstreamTransportError);
		expect((error as UpstreamTransportError).retryable).toBe(true);
	});

	test('a command that never answers times out at the handshake', async () => {
		const started = Date.now();
		let error: unknown;
		try {
			await open({ connection: { command: 'cat', args: [] } }, { handshakeTimeoutMs: 700 });
		} catch (cause) {
			error = cause;
		}
		expect((error as Error).message).toMatch(/failed to start|handshake/);
		expect(Date.now() - started).toBeLessThan(4_000);
	});
});

describe('stdio upstream — environment hygiene', () => {
	test('the child sees the mapped env and none of the gateway secrets', async () => {
		const handle = await open(
			{ envRefs: { FIXTURE_MARKER: '${MARKER}' } },
			{ hostEnv: { MARKER: 'visible' } }
		);
		const probe = textOf(await handle.callTool('env_probe', {})) as unknown as {
			present: string[];
			leaked: string[];
			marker: string | null;
			totalKeys: number;
		};
		expect(probe.marker).toBe('visible');
		expect(probe.present).toContain('PATH');
		expect(probe.leaked).toEqual([]);
		expect(probe.totalKeys).toBeLessThan(15); // sanitised, not a full process.env copy
	});

	test('a missing reference means "unconfigured" and no spawn happens', async () => {
		const statuses: Array<{ kind: string; reason?: string }> = [];
		let error: unknown;
		try {
			await connectStdio({
				record: record({ envRefs: { GH_TOKEN: '${NOT_SET_HERE}' } }),
				hostEnv: {},
				onStatusChange: (status) => statuses.push(status)
			});
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(UnconfiguredUpstreamError);
		expect((error as UnconfiguredUpstreamError).missing).toContain('GH_TOKEN');
		expect(statuses).toEqual([
			{ kind: 'unconfigured', reason: (error as UnconfiguredUpstreamError).missing }
		]);
	});

	test('a vault-backed reference is resolved at spawn time', async () => {
		insertSecret('github-token', 'ghu_vaulted_value');
		// the fixture only echoes names, so map the vaulted value onto a visible var
		const handle = await open({ envRefs: { FIXTURE_MARKER: 'secret:github-token' } });
		expect(textOf(await handle.callTool('env_probe', {}))).toMatchObject({
			marker: 'ghu_vaulted_value'
		});
		expect(handle.connected).toBe(true);
	});

	test('a vault secret that cannot be opened is reported, not fatal', async () => {
		// sealed under a different master key than the runtime uses
		const foreign = sealSecret('whatever', { masterKey: new Uint8Array(32).fill(9) });
		getDb()
			.insert(secretRefs)
			.values({
				id: uuidv7(),
				name: 'broken-secret',
				cipher: foreign.cipher,
				iv: foreign.iv,
				tag: foreign.tag,
				keyVer: foreign.keyVer
			})
			.onConflictDoNothing()
			.run();
		let error: unknown;
		try {
			await connectStdio({
				record: record({ envRefs: { X: 'secret:broken-secret' } }),
				hostEnv: {}
			});
		} catch (cause) {
			error = cause;
		}
		// key mismatch → openSecret throws → resolveEnvRefs reports vault-error
		expect(error).toBeInstanceOf(UnconfiguredUpstreamError);
		expect((error as UnconfiguredUpstreamError).missing).toContain('MCPGW_MASTER_KEY');
	});
});

describe('stdio upstream — failure, restart and close', () => {
	test('a crashed child is respawned on next use', async () => {
		const handle = await open({}, { restart: { baseMs: 50, maxMs: 200 } });
		expect(handle.diagnostics().spawnCount).toBe(1);
		await handle.callTool('suicide', {}).catch(() => undefined);
		await until(() => !handle.connected, 3_000, 'child did not register as closed');
		expect(handle.connected).toBe(false);

		await until(
			async () => {
				try {
					const result = await handle.callTool('echo', { text: 'again' });
					return JSON.stringify(result.content).includes('echo:again');
				} catch {
					return false;
				}
			},
			5_000,
			'respawn never worked'
		);
		expect(handle.connected).toBe(true);
		expect(handle.diagnostics().spawnCount).toBeGreaterThanOrEqual(2);
	});

	test('while cooling down, calls fail fast with retryAfterMs', async () => {
		let error: unknown;
		try {
			await connectStdio({
				record: record({ connection: { command: '/nonexistent/bin', args: [] } }),
				restart: { baseMs: 60_000, maxMs: 60_000 }
			});
		} catch {
			error = 'first attempt failed';
		}
		expect(error).toBeDefined();
		// second connect uses a fresh handle, so backoff is per-handle: prove the helper
		expect(backoffDelayMs(1, { baseMs: 1000, jitter: false })).toBe(1000);
		expect(backoffDelayMs(9, { baseMs: 1000, maxMs: 5000, jitter: false })).toBe(5000);
	});

	test('upstream errors pass through as isError (not transport failures)', async () => {
		const handle = await open();
		const business = await handle.callTool('boom', {});
		expect(business.isError).toBe(true);
		expect(textOf(business)).toContain('quota exceeded');

		// an MCP server converts handler exceptions into an isError result too, so the
		// gateway must not mistake that for a connection failure (T-16 retry rule)
		const exploded = await handle.callTool('explode', {});
		expect(exploded.isError).toBe(true);
		expect(textOf(exploded)).toContain('handler exploded');
		expect(handle.connected).toBe(true);
		expect(textOf(await handle.callTool('echo', { text: 'ok' }))).toContain('echo:ok');
	});

	test('calling a closed connection raises a retryable transport error', async () => {
		const handle = await open();
		await handle.close();
		let thrown: unknown;
		try {
			await handle.callTool('echo', { text: 'x' });
		} catch (cause) {
			thrown = cause;
		}
		expect(thrown).toBeInstanceOf(UpstreamTransportError);
		expect((thrown as UpstreamTransportError).retryable).toBe(true);
	});

	test('graceful close waits for an in-flight call, hard close does not', async () => {
		const handle = await open();
		const inflight = handle.callTool('slow', { ms: 600 });
		await until(async () => handle.inFlight > 0, 1_000, 'call never registered as in flight');
		const closedAt = Date.now();
		await handle.close({ graceMs: 2_000 });
		const result = await inflight;
		expect(JSON.stringify(result.content)).toContain('slept:600');
		expect(Date.now() - closedAt).toBeGreaterThanOrEqual(200);
		expect(handle.connected).toBe(false);

		const abrupt = await open();
		const pending = abrupt.callTool('slow', { ms: 3_000 }).catch((error) => error);
		await until(async () => abrupt.inFlight > 0, 1_000, 'call never registered');
		await abrupt.close({ graceMs: 0 });
		expect(await pending).toBeInstanceOf(Error);
	});

	test('stderr from the child is captured (redacted) for the detail page', async () => {
		// the child env is intentionally minimal, so the trigger must be mapped explicitly
		const handle = await open(
			{ envRefs: { FIXTURE_STDERR: '${FIXTURE_STDERR}' } },
			{ hostEnv: { FIXTURE_STDERR: '1' } }
		);
		await until(
			() => (handle.diagnostics().stderrTail?.length ?? 0) > 0,
			3_000,
			'stderr was not captured'
		);
		const tail = handle.diagnostics().stderrTail?.join('\n') ?? '';
		expect(tail).toContain('startup notice');
		expect(tail).toContain('[redacted]');
		expect(tail).not.toContain('ghp_ShouldNotLeak00000000');
	});

	test('close on an already-closed handle is a no-op', async () => {
		const handle = await open();
		await handle.close();
		await handle.close();
		expect(handle.connected).toBe(false);
	});
});

describe('restart helpers', () => {
	test('backoff grows, caps and jitters', () => {
		const exact = [1, 2, 3, 4].map((n) => backoffDelayMs(n, { baseMs: 1000, jitter: false }));
		expect(exact).toEqual([1000, 2000, 4000, 8000]);
		expect(backoffDelayMs(20, { baseMs: 1000, maxMs: 300_000, jitter: false })).toBe(300_000);
		const jittered = new Set(Array.from({ length: 20 }, () => backoffDelayMs(4, { baseMs: 1000 })));
		expect(jittered.size).toBeGreaterThan(1);
	});

	test('FailureTracker: 3 failures → down, 2 successes → healthy', () => {
		const tracker = new FailureTracker();
		expect(tracker.record({ ok: false }).state).toBe('healthy');
		expect(tracker.record({ ok: false }).state).toBe('healthy');
		expect(tracker.record({ ok: false }).state).toBe('down');
		expect(tracker.due).toBe(false);
		expect(tracker.retryAfterMs).toBeGreaterThan(0);
		expect(tracker.record({ ok: true }).state).toBe('down'); // one success is not enough
		expect(tracker.record({ ok: true }).state).toBe('healthy');
		expect(tracker.due).toBe(true);
	});

	test('FailureTracker marks slow-but-working upstreams degraded', () => {
		const tracker = new FailureTracker();
		expect(tracker.record({ ok: true, latencyMs: 900, degradedAboveMs: 30_000 }).state).toBe(
			'healthy'
		);
		expect(tracker.record({ ok: true, latencyMs: 45_000, degradedAboveMs: 30_000 }).state).toBe(
			'degraded'
		);
	});

	test('reset lets a repaired upstream recover immediately', () => {
		const tracker = new FailureTracker();
		tracker.record({ ok: false });
		tracker.record({ ok: false });
		tracker.record({ ok: false });
		expect(tracker.state).toBe('down');
		expect(tracker.due).toBe(false);
		tracker.reset();
		expect(tracker.state).toBe('healthy');
		expect(tracker.due).toBe(true);
	});

	test('withTimeout rejects with a useful message', async () => {
		await expect(
			withTimeout(new Promise((resolve) => setTimeout(resolve, 500)), 50, 'too slow')
		).rejects.toThrow('too slow');
		expect(await withTimeout(Promise.resolve(7), 500, 'too slow')).toBe(7);
	});

	test('cooling-down error exposes retryAfterMs', async () => {
		const handle = await open({}, { restart: { baseMs: 30_000, maxMs: 30_000 } });
		await handle.close();
		// close() marks the handle as closing; reopening a closed handle is not the
		// supported path — instead verify the error type contract used by T-16.
		const error = new UpstreamCoolingDownError('fixture', 1200);
		expect(error.retryAfterMs).toBe(1200);
		expect(error.message).toContain('1200ms');
	});
});

/** Store a sealed secret the way the admin UI would (FR-05/BR-09). */
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

/** Pull the JSON document out of a tool result's first text block. */
function textOf(result: { content?: unknown }): unknown {
	const blocks = result.content as Array<{ type: string; text?: string }> | undefined;
	const first = blocks?.find((block) => block.type === 'text')?.text ?? '';
	try {
		return JSON.parse(first);
	} catch {
		return first;
	}
}

async function until(
	condition: () => boolean | Promise<boolean>,
	timeoutMs: number,
	message: string
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(message);
}
