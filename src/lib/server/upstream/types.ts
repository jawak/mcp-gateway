/**
 * Shared upstream types (T-06).
 *
 * One `UpstreamHandle` contract implemented by the stdio (T-06) and remote HTTP
 * (T-07) transports, so the pool (T-08), health checker (T-09) and gateway
 * request handlers (T-14…T-18) never branch on transport.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export type StdioConnection = {
	command: string;
	args?: string[];
	cwd?: string;
};

export type HttpConnection = {
	url: string;
	/** How the sealed credential is attached. */
	authStyle?: 'bearer' | 'header' | 'none';
	/** Header name when authStyle === 'header'. */
	authName?: string;
	/** Secret-ref name (e.g. "secret:github-token") holding the credential. */
	authRef?: string;
	/** Extra static headers (non-secret). */
	headers?: Record<string, string>;
	/** Skip certificate verification. Only ever true for an explicit admin choice. */
	insecureTls?: boolean;
};

export type Connection = StdioConnection | HttpConnection;

/** Everything the runtime needs to reach one upstream (a DB row projection). */
export type UpstreamRecord = {
	id: string;
	slug: string;
	name: string;
	transport: 'stdio' | 'http';
	enabled: boolean;
	connection: Connection;
	envRefs: Record<string, string>;
	headersRef?: string | null;
	timeoutMs: number;
	pin: 'pinned' | 'lazy';
	/** Capabilities reported by the upstream at handshake time (may be absent). */
	caps?: Record<string, unknown> | null;
	/** Tool count from the last successful handshake (denormalised for listing). */
	toolsCount?: number;
	/** Newest failure text, so a list page can explain an unconfigured badge. */
	lastError?: string | null;
	/** Last probe outcome, e.g. `{ state: 'down', checkedAt, error }`. */
	status?: { state?: string; checkedAt?: string; error?: string } | null;
};

export type UpstreamStatusKind = 'healthy' | 'degraded' | 'down' | 'unconfigured';

export type UpstreamDiagnostics = {
	serverInfo?: { name: string; version?: string };
	capabilities?: Record<string, unknown>;
	toolsCount?: number;
	lastError?: string;
	/** Last stderr lines from a stdio child (redacted), for the detail page. */
	stderrTail?: string[];
	spawnCount?: number;
};

export type CallToolOptions = {
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
};

export type UpstreamTool = {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
};

export type UpstreamResource = {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
};

export type ToolListResult = { tools: UpstreamTool[]; nextCursor?: string };
export type ResourceListResult = { resources: UpstreamResource[]; nextCursor?: string };
export type ResourceTemplateListResult = {
	resourceTemplates: Array<{
		uriTemplate: string;
		name: string;
		title?: string;
		description?: string;
		mimeType?: string;
	}>;
	nextCursor?: string;
};
export type PromptListResult = { prompts: UpstreamPrompt[]; nextCursor?: string };
export type CallToolResult = { content?: unknown; isError?: boolean; structuredContent?: unknown };
export type ReadResourceResult = { contents: unknown[] };
export type GetPromptResult = { description?: string; messages: unknown[] };

export type UpstreamPrompt = {
	name: string;
	title?: string;
	description?: string;
	arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

/** Return types are the MCP wire shapes; transports cast once at the boundary. */

export type UpstreamHandle = {
	readonly slug: string;
	readonly transport: 'stdio' | 'http';
	readonly connected: boolean;
	/** Requests currently in flight; a graceful close waits for these (BR-12). */
	readonly inFlight: number;
	/** Spawn/resume the underlying connection if it died (stdio) or reconnect (http). */
	ensureAlive(): Promise<void>;
	close(options?: { graceMs?: number }): Promise<void>;
	diagnostics(): UpstreamDiagnostics;
	client(): Client;
	listTools(options?: { timeoutMs?: number }): Promise<ToolListResult>;
	callTool(
		name: string,
		arguments_: Record<string, unknown> | undefined,
		options?: CallToolOptions
	): Promise<CallToolResult>;
	listResources(options?: { timeoutMs?: number }): Promise<ResourceListResult>;
	listResourceTemplates(options?: { timeoutMs?: number }): Promise<ResourceTemplateListResult>;
	readResource(uri: string, options?: { timeoutMs?: number }): Promise<ReadResourceResult>;
	listPrompts(options?: { timeoutMs?: number }): Promise<PromptListResult>;
	getPrompt(
		name: string,
		arguments_: Record<string, unknown> | undefined,
		options?: { timeoutMs?: number }
	): Promise<GetPromptResult>;
	/** Lightweight probe used by the health checker; resolves quickly or throws. */
	ping(timeoutMs: number): Promise<{ latencyMs: number }>;
};

/** Raised when an upstream references env/secret values that do not exist. */
export class UnconfiguredUpstreamError extends Error {
	readonly missing: string;

	constructor(slug: string, missing: string) {
		super(`upstream ${slug} is not configured: ${missing}`);
		this.name = 'UnconfiguredUpstreamError';
		this.missing = missing;
	}
}

/** Raised when a transport error makes a retry worthwhile (T-16 rule). */
export class UpstreamTransportError extends Error {
	readonly retryable: boolean;

	constructor(slug: string, message: string, retryable = true) {
		super(`upstream ${slug}: ${message}`);
		this.name = 'UpstreamTransportError';
		this.retryable = retryable;
	}
}

/** Raised while the restart backoff is still cooling down. */
export class UpstreamCoolingDownError extends Error {
	readonly retryAfterMs: number;

	constructor(slug: string, retryAfterMs: number) {
		super(`upstream ${slug} is cooling down, retry in ${Math.ceil(retryAfterMs)}ms`);
		this.name = 'UpstreamCoolingDownError';
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * Convert anything a transport threw into an `UpstreamTransportError`.
 *
 * The retryability distinction is a safety property, not a performance one:
 * a dead connection means the request never happened (safe to retry), while a
 * timeout means the upstream may well have performed the side effect after we
 * stopped listening — retrying that could send the message or open the PR twice.
 */
export function toTransportError(slug: string, error: unknown): UpstreamTransportError {
	if (error instanceof UpstreamTransportError) return error;
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: string } | undefined)?.code ?? '';
	const timedOut = /timed? ?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|deadline/i.test(
		`${code} ${message}`
	);
	const aborted = (error as { name?: string } | undefined)?.name === 'AbortError';
	return new UpstreamTransportError(slug, message, !timedOut && !aborted);
}

export function isStdioConnection(connection: Connection): connection is StdioConnection {
	return typeof (connection as StdioConnection).command === 'string';
}

export function isHttpConnection(connection: Connection): connection is HttpConnection {
	return typeof (connection as HttpConnection).url === 'string';
}
