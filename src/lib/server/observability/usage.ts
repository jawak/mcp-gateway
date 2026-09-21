/**
 * Tool-call accounting (T-16, extended by T-26).
 *
 * Every call leaves one row in `tool_calls`: who (key), what (qualified +
 * upstream name), how long, how big, and the outcome. That table is the raw
 * material for the admin log page, the usage rollup and the Prometheus metrics,
 * so the important rules here are:
 *
 *  - never let accounting take down a request: a failed insert is logged, not thrown
 *  - never store payloads unless the operator opted in (MCPGW_DEBUG), and even
 *    then cap the size and redact it
 *  - classify the outcome so error rate is computable without parsing text
 */
import { getDb, type Db } from '../db/index.ts';
import { toolCalls } from '../db/schema.ts';
import { uuidv7 } from '../../shared/ids.ts';
import { nowIso } from '../../shared/time.ts';
import { redactValue } from '../security/redact.ts';
import { getConfig } from '../config.ts';
import { logger as rootLogger, type Logger } from '../observability/logger.ts';

export type CallStatus = 'ok' | 'error' | 'timeout' | 'rejected' | 'rate_limited';

export type CallRecord = {
	requestId: string;
	apiKeyId?: string | null;
	upstreamId?: string | null;
	tool: string;
	upstreamTool?: string | null;
	status: CallStatus;
	durationMs: number;
	reqBytes?: number;
	resBytes?: number;
	error?: string | null;
	payload?: { arguments?: unknown; result?: unknown };
	/** Defaults to now; backfills and tests may place a row in time. */
	calledAt?: string;
	db?: Db;
};

let log: Logger | undefined;

/** Map an arbitrary failure onto a status code. */
export function statusFor(error: unknown): CallStatus {
	const message = error instanceof Error ? error.message : String(error);
	if (/timed? ?out|timeout|ETIMEDOUT/i.test(message)) return 'timeout';
	if (/busy|cooling|rate/i.test(message)) return 'rate_limited';
	if (/not allowed|unknown tool|disabled|not configured/i.test(message)) return 'rejected';
	return 'error';
}

function byteLength(value: unknown): number {
	if (value === undefined || value === null) return 0;
	try {
		return Buffer.byteLength(JSON.stringify(value), 'utf8');
	} catch {
		return 0;
	}
}

/** Write one `tool_calls` row. Never throws. */
export function recordCall(entry: CallRecord): void {
	const config = getConfig();
	try {
		(entry.db ?? getDb())
			.insert(toolCalls)
			.values({
				id: uuidv7(),
				requestId: entry.requestId,
				apiKeyId: entry.apiKeyId ?? null,
				upstreamId: entry.upstreamId ?? null,
				tool: entry.tool,
				upstreamTool: entry.upstreamTool ?? null,
				status: entry.status,
				durationMs: Math.max(0, Math.round(entry.durationMs)),
				reqBytes: entry.reqBytes ?? 0,
				resBytes: entry.resBytes ?? 0,
				error: entry.error ? (redactValue(entry.error, { maxString: 500 }) as string) : null,
				debug:
					config.debugPayload && entry.payload
						? ({
								arguments: redactValue(entry.payload.arguments, {
									maxDepth: 4,
									maxString: config.debugMaxBytes
								}),
								result: redactValue(entry.payload.result, {
									maxDepth: 4,
									maxString: config.debugMaxBytes
								})
							} as Record<string, unknown>)
						: null,
				calledAt: entry.calledAt ?? nowIso()
			})
			.run();
	} catch (error) {
		// a missing upstream row (deleted mid-flight) or a full disk must not break
		// the client's call
		log ??= rootLogger.child({ component: 'usage' });
		log.debug({ err: error, tool: entry.tool }, 'tool_calls row not written');
	}
}

export { byteLength };
