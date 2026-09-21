/**
 * The port the MCP endpoint delegates to (T-12).
 *
 * `gateway.ts` speaks MCP protocol; everything that requires knowledge of
 * upstreams, profiles, routing, rate limits and usage lives behind this
 * interface. It is implemented by the aggregator + router (T-14…T-18) and can be
 * replaced wholesale in tests, which keeps protocol-level behaviour (sessions,
 * resumability, capability negotiation) independently verifiable.
 */
import type { CallToolResult, GetPromptResult, ReadResourceResult } from '../upstream/types.ts';

/** Who is calling: the authenticated API key plus per-request metadata. */
export type McpCaller = {
	apiKeyId: string;
	keyName: string;
	profileId: string;
	requestId: string;
	clientAddress: string;
	/** Set once the handshake completed, for logging and capability decisions. */
	protocolVersion?: string;
	clientInfo?: { name: string; version?: string };
};

export type ListPage<T> = { items: T[]; nextCursor?: string };

export type ToolDescriptor = {
	name: string;
	description?: string;
	title?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
	/** Gateway metadata: which upstream this maps to (BR/FR-11). */
	meta: { upstream: string; upstreamTool: string; health: string };
};

export type ResourceDescriptor = {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	meta: { upstream: string };
};

export type ResourceTemplateDescriptor = {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	meta: { upstream: string };
};

export type PromptDescriptor = {
	name: string;
	title?: string;
	description?: string;
	arguments?: Array<{ name: string; description?: string; required?: boolean }>;
	meta: { upstream: string };
};

export type CallToolContext = {
	signal?: AbortSignal;
	/** Forward upstream progress to the calling client. */
	reportProgress?: (progress: {
		progress: number;
		total?: number;
		message?: string;
	}) => Promise<void>;
};

export class ToolNotFoundError extends Error {
	constructor(name: string) {
		super(`unknown tool: ${name}`);
		this.name = 'ToolNotFoundError';
	}
}

export class NotAllowedError extends Error {
	constructor(name: string) {
		super(`tool not allowed for this key: ${name}`);
		this.name = 'NotAllowedError';
	}
}

export class UpstreamUnavailableError extends Error {
	readonly retryAfterMs: number;

	constructor(slug: string, reason: string, retryAfterMs = 0) {
		super(`upstream ${slug} is unavailable: ${reason}`);
		this.name = 'UpstreamUnavailableError';
		this.retryAfterMs = retryAfterMs;
	}
}

export interface GatewayBackend {
	/** Aggregated, namespaced, profile-filtered tool list. */
	listTools(caller: McpCaller, page: { cursor?: string }): Promise<ListPage<ToolDescriptor>>;
	callTool(
		caller: McpCaller,
		name: string,
		args: Record<string, unknown> | undefined,
		context: CallToolContext
	): Promise<CallToolResult>;
	listResources(
		caller: McpCaller,
		page: { cursor?: string }
	): Promise<ListPage<ResourceDescriptor>>;
	listResourceTemplates(
		caller: McpCaller,
		page: { cursor?: string }
	): Promise<ListPage<ResourceTemplateDescriptor>>;
	readResource(caller: McpCaller, uri: string): Promise<ReadResourceResult>;
	listPrompts(caller: McpCaller, page: { cursor?: string }): Promise<ListPage<PromptDescriptor>>;
	getPrompt(
		caller: McpCaller,
		name: string,
		args: Record<string, unknown> | undefined
	): Promise<GetPromptResult>;
	/** True when the profile exposes at least one upstream supporting resource subscriptions. */
	supportsResourceSubscribe?(caller: McpCaller): boolean;
	/** Called when a session is created, so list-changed notifications can be pushed. */
	watch?(
		sessionId: string,
		caller: McpCaller,
		notify: (method: string) => Promise<void>
	): () => void;
}
