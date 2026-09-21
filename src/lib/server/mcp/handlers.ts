/**
 * Gateway backend (T-16, T-17, T-18): the real implementation of the port the
 * MCP endpoint delegates to.
 *
 * Routing rules that matter:
 *  - the catalog decides what a key may see *and* call, so `tools/list` and
 *    `tools/call` can never disagree (a filtered tool is unreachable by guessing)
 *  - a retryable transport failure is retried exactly once, and only for
 *    transport failures: `isError: true` from the upstream is a real answer and
 *    retrying it would double a side effect (send a message, open a PR)
 *  - every call is accounted in `tool_calls`, including rejected and rate-limited
 *    ones, so the error rate and usage views are trustworthy
 *  - timeouts come from the upstream record (capped by config) and the client's
 *    abort signal is forwarded, so a cancelled client stops upstream work
 */
import type { CallToolResult, GetPromptResult } from '../upstream/types.ts';
import type {
	CallToolContext,
	GatewayBackend,
	ListPage,
	McpCaller,
	PromptDescriptor,
	ResourceDescriptor,
	ToolDescriptor
} from './backend.ts';
import { NotAllowedError, ToolNotFoundError, UpstreamUnavailableError } from './backend.ts';
import type { ToolCatalog } from './catalog.ts';
import type { UpstreamPool } from '../upstream/pool.ts';
import {
	UpstreamCoolingDownError,
	UpstreamTransportError,
	type UpstreamRecord
} from '../upstream/types.ts';
import { recordCall, statusFor, byteLength } from '../observability/usage.ts';
import { getConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { logger as rootLogger, type Logger } from '../observability/logger.ts';
import { redactString } from '../security/redact.ts';

export type BackendOptions = {
	catalog: ToolCatalog;
	pool: UpstreamPool;
	/**
	 * Governance seam (T-24): per-key concurrency, request budget and daily
	 * quota. `acquire` resolves when a slot is free or throws; the returned
	 * function releases the slot.
	 */
	guard?: {
		acquire: (caller: McpCaller, meta: { tool: string }) => Promise<() => void>;
	};
	db?: Db;
	log?: Logger;
};

export function createGatewayBackend(options: BackendOptions): GatewayBackend {
	const config = getConfig();
	const log = options.log ?? rootLogger.child({ component: 'gateway-backend' });

	async function listTools(
		caller: McpCaller,
		page: { cursor?: string }
	): Promise<ListPage<ToolDescriptor>> {
		return options.catalog.listTools(caller.profileId, page);
	}

	async function callTool(
		caller: McpCaller,
		name: string,
		args: Record<string, unknown> | undefined,
		context: CallToolContext
	): Promise<CallToolResult> {
		const started = Date.now();
		const resolved = await options.catalog.resolve(caller.profileId, name);
		if (!resolved) {
			const verdict = options.catalog.classify(caller.profileId, name);
			recordCall({
				requestId: caller.requestId,
				apiKeyId: caller.apiKeyId,
				tool: name,
				status: 'rejected',
				durationMs: Date.now() - started,
				reqBytes: byteLength(args),
				error:
					verdict === 'filtered'
						? `tool ${name} is not exposed to this key`
						: `unknown tool ${name}`,
				db: options.db
			});
			// the endpoint maps these to distinct JSON-RPC codes
			if (verdict === 'filtered') throw new NotAllowedError(name);
			throw new ToolNotFoundError(name);
		}

		const { upstream, original } = resolved;
		const release = options.guard
			? await options.guard.acquire(caller, { tool: name })
			: () => undefined;
		try {
			const result = await attempt(upstream, original, args, context);
			recordCall({
				requestId: caller.requestId,
				apiKeyId: caller.apiKeyId,
				upstreamId: upstream.id,
				tool: name,
				upstreamTool: original,
				status: result.isError ? 'error' : 'ok',
				durationMs: Date.now() - started,
				reqBytes: byteLength(args),
				resBytes: byteLength(result.content ?? result.structuredContent),
				error: result.isError ? firstText(result) : null,
				payload: { arguments: args, result },
				db: options.db
			});
			return result;
		} catch (error) {
			recordCall({
				requestId: caller.requestId,
				apiKeyId: caller.apiKeyId,
				upstreamId: upstream.id,
				tool: name,
				upstreamTool: original,
				status: error instanceof UpstreamUnavailableError ? 'rejected' : statusFor(error),
				durationMs: Date.now() - started,
				reqBytes: byteLength(args),
				error: error instanceof Error ? error.message : String(error),
				payload: { arguments: args },
				db: options.db
			});
			throw error;
		} finally {
			release();
		}
	}

	/**
	 * One call, with at most one retry — and only when the transport died (a dead
	 * stdio child or a dropped remote session), never when the upstream answered
	 * with an error.
	 */
	async function attempt(
		upstream: UpstreamRecord,
		original: string,
		args: Record<string, unknown> | undefined,
		context: CallToolContext
	): Promise<CallToolResult> {
		if (!upstream.enabled)
			throw new UpstreamUnavailableError(upstream.slug, 'upstream is disabled');
		const timeoutMs = Math.min(upstream.timeoutMs, config.upstreamMaxTimeoutMs);
		const invoke = () =>
			options.pool.withHandle(upstream, (handle) =>
				handle.callTool(original, args, {
					timeoutMs,
					signal: context.signal,
					onProgress: context.reportProgress
						? async (progress) => {
								await context.reportProgress?.(progress);
							}
						: undefined
				})
			);

		// First attempt, then exactly one retry — only for a dead connection. Both
		// attempts share the cool-down policy through invokeThroughCooldown().
		try {
			return await invokeThroughCooldown(invoke, context);
		} catch (error) {
			if (!(error instanceof UpstreamTransportError) || !error.retryable || context.signal?.aborted)
				throw error;

			log.warn(
				{ slug: upstream.slug, reason: redactString(error.message).slice(0, 200) },
				'transport failure, retrying once'
			);
			// the handle respawns itself on next use; nudge it before trying again
			await options.pool
				.peek(upstream.slug)
				?.ensureAlive()
				.catch(() => undefined);
			try {
				return await invokeThroughCooldown(invoke, context);
			} catch (second) {
				if (second instanceof UpstreamTransportError) {
					throw new UpstreamUnavailableError(upstream.slug, second.message);
				}
				throw second;
			}
		}
	}

	/**
	 * Call, waiting out a restart backoff that is about to expire.
	 *
	 * A child that just crashed is scheduled to respawn within a second; failing
	 * the call at that moment would penalise the model for a failure that self-heals
	 * almost immediately. Longer cool-downs still fail fast so a genuinely broken
	 * upstream cannot pin request slots.
	 */
	async function invokeThroughCooldown(
		invoke: () => Promise<CallToolResult>,
		context: CallToolContext
	): Promise<CallToolResult> {
		let waited = 0;
		for (;;) {
			try {
				return await invoke();
			} catch (error) {
				if (!(error instanceof UpstreamCoolingDownError)) throw error;
				if (context.signal?.aborted) throw error;
				if (waited + error.retryAfterMs > COOLDOWN_WAIT_BUDGET_MS) throw error;
				const pause = Math.ceil(error.retryAfterMs) + COOLDOWN_SLACK_MS;
				await sleep(pause, context.signal);
				waited += pause;
			}
		}
	}

	async function listResources(
		caller: McpCaller,
		page: { cursor?: string }
	): Promise<ListPage<ResourceDescriptor>> {
		return options.catalog.listResources(caller.profileId, page);
	}

	async function listResourceTemplates(caller: McpCaller, page: { cursor?: string }) {
		return options.catalog.listResourceTemplates(caller.profileId, page);
	}

	async function readResource(
		caller: McpCaller,
		qualifiedUri: string
	): Promise<{ contents: unknown[] }> {
		const started = Date.now();
		const resolved = await options.catalog.resolveResourceUri(caller.profileId, qualifiedUri);
		if (!resolved) throw new NotAllowedError(qualifiedUri);
		const { upstream, uri } = resolved;
		try {
			const result = await options.pool.withHandle(upstream, (handle) =>
				handle.readResource(uri, {
					timeoutMs: Math.min(upstream.timeoutMs, getConfig().upstreamMaxTimeoutMs)
				})
			);
			log.debug({ slug: upstream.slug, uri }, 'resource read');
			return result;
		} catch (error) {
			if (error instanceof UpstreamTransportError)
				throw new UpstreamUnavailableError(upstream.slug, error.message);
			throw error;
		} finally {
			void started;
		}
	}

	async function listPrompts(
		caller: McpCaller,
		page: { cursor?: string }
	): Promise<ListPage<PromptDescriptor>> {
		return options.catalog.listPrompts(caller.profileId, page);
	}

	async function getPrompt(
		caller: McpCaller,
		qualifiedName: string,
		args: Record<string, unknown> | undefined
	): Promise<GetPromptResult> {
		const resolved = await options.catalog.resolvePromptName(caller.profileId, qualifiedName);
		if (!resolved) {
			const verdict = options.catalog.classify(caller.profileId, qualifiedName);
			if (verdict === 'filtered') throw new NotAllowedError(qualifiedName);
			throw new ToolNotFoundError(qualifiedName);
		}
		const { upstream, name } = resolved;
		try {
			return await options.pool.withHandle(upstream, (handle) =>
				handle.getPrompt(name, args, {
					timeoutMs: Math.min(upstream.timeoutMs, getConfig().upstreamMaxTimeoutMs)
				})
			);
		} catch (error) {
			if (error instanceof UpstreamTransportError)
				throw new UpstreamUnavailableError(upstream.slug, error.message);
			throw error;
		}
	}

	function supportsResourceSubscribe(caller: McpCaller): boolean {
		// Advertise subscribe only when every in-scope upstream declared it, so a
		// client never receives a subscription that would be silently dropped (BR-14).
		// Capabilities come from the upstream's own initialize result: the live
		// connection when there is one, otherwise the value stored at handshake time.
		const links = options.catalog.scopeFor(caller.profileId);
		if (links.length === 0) return false;
		return links.every((link) => {
			const capabilities =
				options.pool.peek(link.upstream.slug)?.diagnostics().capabilities ??
				(link.upstream.caps as Record<string, unknown> | null);
			const resources = capabilities?.resources as { subscribe?: boolean } | undefined;
			return resources?.subscribe === true;
		});
	}

	return {
		listTools,
		callTool,
		listResources,
		listResourceTemplates,
		readResource,
		listPrompts,
		getPrompt,
		supportsResourceSubscribe
	};
}

/** How long a call will wait for an upstream to leave its restart backoff. */
const COOLDOWN_WAIT_BUDGET_MS = 3_000;
/** Timers can fire slightly early; wait a touch longer than asked. */
const COOLDOWN_SLACK_MS = 25;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener?.('abort', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/** Best-effort text extraction for the error column of tool_calls. */
function firstText(result: CallToolResult): string {
	const content = result.content;
	if (Array.isArray(content)) {
		const text = content.find(
			(block) =>
				typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
		) as { text?: string } | undefined;
		if (text?.text) return redactString(text.text).slice(0, 500);
	}
	return 'upstream reported an error';
}
