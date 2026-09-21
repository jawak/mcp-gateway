/**
 * Remote HTTP upstream transport (T-07).
 *
 * Speaks MCP Streamable HTTP to a hosted upstream. Three rules from the PRD
 * matter here:
 *
 *  1. **SSRF guard:** the URL is validated (scheme, no embedded credentials, DNS
 *     answers must not be link-local/private unless explicitly allowed) and every
 *     request goes through `createSsrfSafeFetch`, which refuses redirects and
 *     enforces a connect timeout.
 *  2. **Secrets:** credentials are opened from the vault at connect time and
 *     attached as headers; they are never returned by `diagnostics()` nor logged.
 *  3. **Degradation:** a failing remote (5xx, DNS error, TLS error) surfaces as a
 *     retryable `UpstreamTransportError`; the handle reconnects on next use.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
	CallToolOptions,
	CallToolResult,
	GetPromptResult,
	HttpConnection,
	PromptListResult,
	ReadResourceResult,
	ResourceListResult,
	ResourceTemplateListResult,
	ToolListResult,
	UpstreamDiagnostics,
	UpstreamHandle,
	UpstreamRecord
} from './types.ts';
import { UnconfiguredUpstreamError, UpstreamTransportError, toTransportError } from './types.ts';
import { assertUrlAllowed, createSsrfSafeFetch, type SsrfOptions } from '../security/ssrf.ts';
import { redactString } from '../security/redact.ts';
import { getConfig } from '../config.ts';
import { logger as rootLogger } from '../observability/logger.ts';
import { openSecretByName, withTimeout } from './stdio.ts';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.ts';
import { secretRefs } from '../db/schema.ts';

export type RemoteHttpOptions = {
	record: UpstreamRecord;
	handshakeTimeoutMs?: number;
	ssrf?: SsrfOptions;
	onStatusChange?: (status: { kind: 'healthy' | 'down' | 'unconfigured'; reason?: string }) => void;
	logger?: ReturnType<typeof rootLogger.child>;
};

/** Header name used when an upstream is configured with `authStyle: 'header'`. */
const DEFAULT_AUTH_HEADER = 'authorization';

/** Open a JSON object of static/extra headers from a `secret:` reference. */
function openHeaderSecret(name: string): Record<string, string> {
	const row = getDb().select().from(secretRefs).where(eq(secretRefs.name, name)).get();
	if (!row) throw new UnconfiguredUpstreamError(name, `header secret "${name}" is missing`);
	const raw = openSecretByName(row.name);
	if (raw === undefined)
		throw new UnconfiguredUpstreamError(name, `header secret "${name}" could not be read`);
	try {
		const parsed = JSON.parse(raw) as Record<string, string>;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new Error('not an object');
		return parsed;
	} catch (cause) {
		throw new UnconfiguredUpstreamError(
			name,
			`header secret "${name}" must contain a JSON object (${(cause as Error).message})`
		);
	}
}

export async function connectRemoteHttp(options: RemoteHttpOptions): Promise<UpstreamHandle> {
	const { record } = options;
	const config = getConfig();
	const log = (options.logger ?? rootLogger).child({
		component: 'upstream-http',
		slug: record.slug
	});
	const connection = record.connection as HttpConnection;
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? Math.min(record.timeoutMs, 20_000);

	if (typeof connection?.url !== 'string' || connection.url.length === 0) {
		throw new UnconfiguredUpstreamError(record.slug, 'no url configured');
	}

	const ssrfOptions: SsrfOptions = {
		allowPrivateNetwork: config.allowPrivateNetwork,
		allowLoopback: true,
		...options.ssrf
	};

	let client: Client | undefined;
	let connected = false;
	let closing = false;
	let connectCount = 0;
	let lastError: string | undefined;
	let inFlight = 0;
	let meta: Pick<UpstreamDiagnostics, 'serverInfo' | 'capabilities' | 'toolsCount'> = {};
	let safeFetch: ReturnType<typeof createSsrfSafeFetch>;

	/** Build the header set: static headers, then the credential, then per-upstream extras. */
	async function buildHeaders(): Promise<Record<string, string>> {
		const headers: Record<string, string> = { ...(connection.headers ?? {}) };
		if (record.headersRef) {
			const refName = record.headersRef.startsWith('secret:')
				? record.headersRef.slice('secret:'.length)
				: record.headersRef;
			Object.assign(headers, openHeaderSecret(refName));
		}
		const style = connection.authStyle ?? (connection.authRef ? 'bearer' : 'none');
		if (style === 'none' || !connection.authRef) return headers;

		const secretName = connection.authRef.startsWith('secret:')
			? connection.authRef.slice('secret:'.length)
			: connection.authRef;
		const credential = openSecretByName(secretName);
		if (credential === undefined) {
			const reason = `credential "${secretName}" is missing — add it in the upstream form`;
			options.onStatusChange?.({ kind: 'unconfigured', reason });
			throw new UnconfiguredUpstreamError(record.slug, reason);
		}
		if (style === 'bearer') {
			// honour a custom header name (some gateways expect e.g. X-Api-Key with a bearer value)
			const name = (connection.authName ?? DEFAULT_AUTH_HEADER).toLowerCase();
			headers[name] = /^bearer /i.test(credential) ? credential : `Bearer ${credential}`;
		} else {
			headers[(connection.authName ?? DEFAULT_AUTH_HEADER).toLowerCase()] = credential;
		}
		return headers;
	}

	async function connect(): Promise<void> {
		const target = await assertUrlAllowed(connection.url, ssrfOptions);
		safeFetch = createSsrfSafeFetch({ ...ssrfOptions, timeoutMs: record.timeoutMs });
		const headers = await buildHeaders();

		const transport = new StreamableHTTPClientTransport(target.url, {
			requestInit: { headers },
			fetch: safeFetch
		});
		const nextClient = new Client({ name: 'mcp-gateway', version: '1.0.0' }, { capabilities: {} });
		// Compact by design: the health monitor reports state transitions, so this
		// fires per failed probe and must not dump a stack every time.
		transport.onerror = (error: Error) => {
			log.debug(
				{ code: (error as Error & { code?: string }).code, message: redactString(error.message) },
				'upstream transport error'
			);
		};
		transport.onclose = () => {
			const wasConnected = connected;
			connected = false;
			if (closing || !wasConnected) return;
			lastError = 'remote session closed';
			log.warn('upstream connection lost');
			options.onStatusChange?.({ kind: 'down', reason: lastError });
		};

		connectCount += 1;
		try {
			await withTimeout(
				nextClient.connect(transport),
				handshakeTimeoutMs,
				`handshake timed out after ${handshakeTimeoutMs}ms`
			);
		} catch (error) {
			await nextClient.close().catch(() => undefined);
			const message = redactString(
				`could not reach ${target.url.origin}${target.url.pathname}: ${(error as Error).message}`
			);
			lastError = message;
			throw new UpstreamTransportError(record.slug, message, true);
		}

		client = nextClient;
		connected = true;
		lastError = undefined;
		const version = nextClient.getServerVersion();
		meta = {
			...meta,
			serverInfo: version ? { name: version.name, version: version.version } : undefined,
			capabilities: (nextClient.getServerCapabilities() ?? {}) as Record<string, unknown>
		};
		log.info(
			{ server: version?.name, version: version?.version, connectCount },
			'upstream connected'
		);
		options.onStatusChange?.({ kind: 'healthy' });
	}

	function active(): Client {
		if (!client || !connected) throw new UpstreamTransportError(record.slug, 'not connected');
		return client;
	}

	async function ready(): Promise<Client> {
		await handle.ensureAlive();
		return active();
	}

	const handle: UpstreamHandle = {
		slug: record.slug,
		transport: 'http',
		get connected() {
			return connected;
		},
		get inFlight() {
			return inFlight;
		},

		async ensureAlive() {
			if (closing) throw new UpstreamTransportError(record.slug, 'handle is closed');
			if (connected && client) return;
			await connect();
		},

		async close(closeOptions = {}) {
			closing = true;
			const deadline = Date.now() + (closeOptions.graceMs ?? 0);
			while (inFlight > 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const target = client;
			client = undefined;
			connected = false;
			if (target) {
				// the SDK sends the MCP session DELETE; never let that reject the close
				await Promise.race([
					target.close().catch(() => undefined),
					new Promise((resolve) => setTimeout(resolve, 2_000))
				]);
			}
			log.info({ connectCount, inFlightAtClose: inFlight }, 'upstream closed');
		},

		diagnostics() {
			return {
				...meta,
				// deliberately no headers/credentials: the dashboard must stay shareable
				stderrTail: [],
				spawnCount: connectCount,
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
				// timeouts and cancellations stay non-retryable (see toTransportError)
				throw toTransportError(record.slug, error);
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

		async listResourceTemplates(listOptions = {}): Promise<ResourceTemplateListResult> {
			const result = await (
				await ready()
			).listResourceTemplates(undefined, {
				timeout: listOptions.timeoutMs ?? record.timeoutMs
			});
			return {
				resourceTemplates:
					result.resourceTemplates as unknown as ResourceTemplateListResult['resourceTemplates'],
				nextCursor: result.nextCursor
			};
		},

		async readResource(uri, readOptions = {}): Promise<ReadResourceResult> {
			const result = await (
				await ready()
			).readResource(
				{ uri },
				{
					timeout: readOptions.timeoutMs ?? record.timeoutMs
				}
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
			const result = await (
				await ready()
			).getPrompt(
				{ name, arguments: arguments_ as Record<string, string> | undefined },
				{ timeout: getOptions.timeoutMs ?? record.timeoutMs }
			);
			return { description: result.description, messages: result.messages as unknown[] };
		},

		async ping(timeoutMs) {
			const started = Date.now();
			const activeClient = await ready();
			await withTimeout(
				activeClient.ping({ timeout: timeoutMs }),
				timeoutMs + 500,
				`ping timed out after ${timeoutMs}ms`
			);
			return { latencyMs: Date.now() - started };
		}
	};

	await handle.ensureAlive();
	return handle;
}
