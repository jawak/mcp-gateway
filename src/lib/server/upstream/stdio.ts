/**
 * stdio upstream transport (T-06).
 *
 * Spawns a local MCP server as a child process. Two hard rules from the PRD are
 * enforced here:
 *
 *  1. **Env hygiene:** the child receives `baseProcessEnv()` (PATH, HOME, …) plus
 *     only the variables the admin mapped in `env_refs`. The gateway's own
 *     secrets (master key, cookie secret, admin password) are never inherited — a
 *     malicious `npx` package must not be able to read them.
 *  2. **Degradation:** a missing env/secret reference marks the upstream
 *     `unconfigured` (no spawn, actionable message), and a crashing child is
 *     respawned with exponential backoff instead of taking the gateway down.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { eq } from 'drizzle-orm';
import type {
	CallToolOptions,
	CallToolResult,
	GetPromptResult,
	PromptListResult,
	ReadResourceResult,
	ResourceListResult,
	StdioConnection,
	ToolListResult,
	UpstreamDiagnostics,
	UpstreamHandle,
	UpstreamRecord
} from './types.ts';
import {
	UnconfiguredUpstreamError,
	UpstreamCoolingDownError,
	UpstreamTransportError
} from './types.ts';
import { backoffDelayMs } from './restart.ts';
import { baseProcessEnv, describeMissing, resolveEnvRefs } from '../security/env-resolve.ts';
import { openSecret } from '../security/vault.ts';
import { redactString, redactValue } from '../security/redact.ts';
import { logger as rootLogger } from '../observability/logger.ts';
import { getDb } from '../db/index.ts';
import { secretRefs } from '../db/schema.ts';

export type StdioHandleOptions = {
	record: UpstreamRecord;
	/** Defaults to `process.env`. */
	hostEnv?: Record<string, string | undefined>;
	handshakeTimeoutMs?: number;
	/** Backoff bounds for respawn after a crash or a failed handshake. */
	restart?: { baseMs?: number; maxMs?: number };
	/** Cap for the child's stdout message buffer. */
	maxBufferSizeBytes?: number;
	onStatusChange?: (status: { kind: 'healthy' | 'down' | 'unconfigured'; reason?: string }) => void;
	logger?: ReturnType<typeof rootLogger.child>;
};

const STDERR_TAIL_LINES = 40;
const CLIENT_INFO = { name: 'mcp-gateway', version: '1.0.0' } as const;

/** Open a `secret:<name>` reference against the vault (T-05). */
export function openSecretByName(name: string): string | undefined {
	const row = getDb().select().from(secretRefs).where(eq(secretRefs.name, name)).get();
	if (!row) return undefined;
	return openSecret({ cipher: row.cipher, iv: row.iv, tag: row.tag, keyVer: row.keyVer });
}

/** Race a promise against a timeout (shared by transports and health probes). */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), ms);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export async function connectStdio(options: StdioHandleOptions): Promise<UpstreamHandle> {
	const { record } = options;
	const log = (options.logger ?? rootLogger).child({
		component: 'upstream-stdio',
		slug: record.slug
	});
	const connection = record.connection as StdioConnection;
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? Math.min(record.timeoutMs, 20_000);

	if (typeof connection?.command !== 'string' || connection.command.length === 0) {
		throw new UnconfiguredUpstreamError(record.slug, 'no command configured');
	}

	const resolved = resolveEnvRefs(record.envRefs, {
		readEnv: (name) => (options.hostEnv ?? process.env)[name],
		openSecret: openSecretByName
	});
	if (resolved.missing.length > 0) {
		const reason = describeMissing(resolved.missing);
		options.onStatusChange?.({ kind: 'unconfigured', reason });
		throw new UnconfiguredUpstreamError(record.slug, reason);
	}

	const env: Record<string, string> = {
		...baseProcessEnv(options.hostEnv ?? process.env),
		...resolved.values
	};

	const stderrTail: string[] = [];
	let stderrBuffer = '';
	let client: Client | undefined;
	let connected = false;
	let closing = false;
	let spawnCount = 0;
	let consecutiveFailures = 0;
	let coolingUntil = 0;
	let inFlight = 0;
	let lastError: string | undefined;
	let meta: Pick<UpstreamDiagnostics, 'serverInfo' | 'capabilities' | 'toolsCount'> = {};

	function noteStderr(chunk: string): void {
		stderrBuffer += chunk;
		const lines = stderrBuffer.split('\n');
		stderrBuffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			stderrTail.push(redactString(line.slice(0, 500)));
			while (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
		}
	}

	function attachStderr(transport: StdioClientTransport): void {
		const stream = (transport as unknown as { stderr?: unknown }).stderr as
			ReadableStream<Uint8Array> | NodeJS.ReadableStream | undefined;
		if (!stream) return;
		if (typeof (stream as ReadableStream).getReader === 'function') {
			void (async () => {
				const reader = (stream as ReadableStream<Uint8Array>).getReader();
				const decoder = new TextDecoder();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						noteStderr(decoder.decode(value, { stream: true }));
					}
				} catch {
					/* child closed stderr */
				} finally {
					reader.releaseLock();
				}
			})();
			return;
		}
		(stream as NodeJS.ReadableStream).on?.('data', (chunk: Buffer) => noteStderr(chunk.toString()));
	}

	async function spawn(): Promise<void> {
		const transport = new StdioClientTransport({
			command: connection.command,
			args: connection.args ?? [],
			env,
			cwd: connection.cwd,
			stderr: 'pipe',
			maxBufferSize: options.maxBufferSizeBytes ?? 10 * 1024 * 1024
		});
		const nextClient = new Client(CLIENT_INFO, { capabilities: {} });

		transport.onerror = (error: Error) => {
			log.warn({ err: error }, 'upstream transport error');
		};
		transport.onclose = () => {
			const wasConnected = connected;
			connected = false;
			if (closing || !wasConnected) return;
			consecutiveFailures += 1;
			const retryAfterMs = backoffDelayMs(consecutiveFailures, options.restart);
			coolingUntil = Date.now() + retryAfterMs;
			lastError = 'connection closed (child process exited?)';
			log.error({ retryAfterMs, spawnCount }, 'upstream connection lost');
			options.onStatusChange?.({ kind: 'down', reason: lastError });
		};

		attachStderr(transport);
		spawnCount += 1;

		try {
			await withTimeout(
				nextClient.connect(transport),
				handshakeTimeoutMs,
				`handshake timed out after ${handshakeTimeoutMs}ms`
			);
		} catch (error) {
			await safeClose(nextClient);
			client = undefined;
			connected = false;
			const message = redactString(
				`failed to start "${connection.command} ${(connection.args ?? []).join(' ')}".exit: ${(error as Error).message}`
			);
			lastError = message;
			throw new UpstreamTransportError(record.slug, message, true);
		}

		client = nextClient;
		connected = true;
		consecutiveFailures = 0;
		coolingUntil = 0;
		lastError = undefined;
		const version = nextClient.getServerVersion();
		meta = {
			...meta,
			serverInfo: version ? { name: version.name, version: version.version } : undefined,
			capabilities: (nextClient.getServerCapabilities() ?? {}) as Record<string, unknown>
		};
		log.info(
			{ server: version?.name, version: version?.version, spawnCount },
			'upstream connected'
		);
		options.onStatusChange?.({ kind: 'healthy' });
	}

	async function safeClose(target: Client | undefined): Promise<void> {
		try {
			await target?.close();
		} catch {
			/* closing is best-effort; the child is usually already gone */
		}
	}

	function active(): Client {
		if (!client || !connected) throw new UpstreamTransportError(record.slug, 'not connected');
		return client;
	}

	/**
	 * Every request path self-heals: a child that died between calls is respawned
	 * (subject to the restart backoff), so a crash costs one delayed call instead of
	 * an upstream that stays broken until an admin intervenes.
	 */
	async function ready(): Promise<Client> {
		await handle.ensureAlive();
		return active();
	}

	const handle: UpstreamHandle = {
		slug: record.slug,
		transport: 'stdio',
		get connected() {
			return connected;
		},
		get inFlight() {
			return inFlight;
		},

		async ensureAlive() {
			if (closing) throw new UpstreamTransportError(record.slug, 'handle is closed');
			if (connected && client) return;
			if (Date.now() < coolingUntil) {
				throw new UpstreamCoolingDownError(record.slug, coolingUntil - Date.now());
			}
			await spawn();
		},

		async close(closeOptions = {}) {
			closing = true;
			const deadline = Date.now() + (closeOptions.graceMs ?? 0);
			while (inFlight > 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			await safeClose(client);
			client = undefined;
			connected = false;
			log.info({ spawnCount, inFlightAtClose: inFlight }, 'upstream closed');
		},

		diagnostics() {
			return {
				...meta,
				stderrTail: [...stderrTail],
				spawnCount,
				lastError
			};
		},

		client: active,

		async listTools(listOptions = {}): Promise<ToolListResult> {
			const result = await (
				await ready()
			).listTools(undefined, {
				timeout: listOptions.timeoutMs ?? record.timeoutMs
			});
			meta = { ...meta, toolsCount: result.tools.length };
			return {
				tools: result.tools as unknown as ToolListResult['tools'],
				nextCursor: result.nextCursor
			};
		},

		async callTool(name, arguments_, callOptions: CallToolOptions = {}): Promise<CallToolResult> {
			const connection_ = await ready();
			inFlight += 1;
			try {
				const result = await connection_.callTool({ name, arguments: arguments_ }, undefined, {
					timeout: callOptions.timeoutMs ?? record.timeoutMs,
					signal: callOptions.signal,
					resetTimeoutOnProgress: true,
					// the SDK hands the progress fields over directly (no .params wrapper)
					onprogress: callOptions.onProgress
						? (progress) =>
								callOptions.onProgress?.({
									progress: progress.progress,
									total: progress.total,
									message: progress.message
								})
						: undefined
				});
				return result as CallToolResult;
			} catch (error) {
				if (error instanceof UpstreamTransportError) throw error;
				throw new UpstreamTransportError(record.slug, redactString(messageOf(error)), true);
			} finally {
				inFlight -= 1;
			}
		},

		async listResources(listOptions = {}): Promise<ResourceListResult> {
			const result = await (
				await ready()
			).listResources(undefined, {
				timeout: listOptions.timeoutMs ?? record.timeoutMs
			});
			return {
				resources: result.resources as unknown as ResourceListResult['resources'],
				nextCursor: result.nextCursor
			};
		},

		async readResource(uri, readOptions = {}): Promise<ReadResourceResult> {
			const result = await active().readResource(
				{ uri },
				{ timeout: readOptions.timeoutMs ?? record.timeoutMs }
			);
			return { contents: result.contents as unknown[] };
		},

		async listPrompts(listOptions = {}): Promise<PromptListResult> {
			const result = await (
				await ready()
			).listPrompts(undefined, {
				timeout: listOptions.timeoutMs ?? record.timeoutMs
			});
			return {
				prompts: result.prompts as unknown as PromptListResult['prompts'],
				nextCursor: result.nextCursor
			};
		},

		async getPrompt(name, arguments_, getOptions = {}): Promise<GetPromptResult> {
			// MCP prompt arguments are string-valued; we pass the client payload
			// through and let the upstream's own schema reject anything invalid.
			const result = await (
				await ready()
			).getPrompt(
				{ name, arguments: arguments_ as Record<string, string> | undefined },
				{
					timeout: getOptions.timeoutMs ?? record.timeoutMs
				}
			);
			return { description: result.description, messages: result.messages as unknown[] };
		},

		async ping(timeoutMs) {
			const started = Date.now();
			await withTimeout(
				active().ping({ timeout: timeoutMs }),
				timeoutMs + 500,
				`ping timed out after ${timeoutMs}ms`
			);
			return { latencyMs: Date.now() - started };
		}
	};

	await handle.ensureAlive();
	return handle;
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/** Redacted snapshot for the dashboard / API responses. */
export function redactDiagnostics(value: UpstreamDiagnostics): UpstreamDiagnostics {
	return redactValue(value, { maxDepth: 4 }) as UpstreamDiagnostics;
}
