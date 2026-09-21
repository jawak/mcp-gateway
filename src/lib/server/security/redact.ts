/**
 * Credential redaction (T-05).
 *
 * Used in three places, all of which handle untrusted or third-party text:
 *   1. tool call payloads/errors stored in `tool_calls.debug` (only when MCPGW_DEBUG)
 *   2. log lines (`pino` redacts known keys; this catches secrets inside strings)
 *   3. manifest import validation, where `findSecretLike` blocks a YAML that
 *      inlined a real token instead of a `${ENV}` reference (BR-09)
 *
 * The list is deliberately pattern-based rather than allow-listed: upstream MCP
 * servers echo whatever the user put in their config, so a new token format
 * should fail closed (get redacted) rather than leak.
 */

export type SecretPattern = { name: string; pattern: RegExp };

/** Ordered; first match wins per region, so put narrow patterns first. */
export const SECRET_PATTERNS: SecretPattern[] = [
	{
		name: 'private-key-block',
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
	},
	{ name: 'gateway-key', pattern: /\bmcpgw_[A-Za-z0-9]{8,}\b/g },
	{
		name: 'github-token',
		pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
	},
	{ name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
	{ name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
	{ name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
	{ name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
	{ name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
	{ name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
	{ name: 'stripe-key', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
	{ name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
	{ name: 'basic-auth-url', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi },
	{
		name: 'bearer-header',
		pattern: /\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)\s+\S+/gi
	},
	{
		name: 'assignment',
		pattern:
			/\b([a-z0-9_.-]*(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|client[-_]?secret|authorization|cookie)[a-z0-9_.-]*)\s*[:=]\s*("[^"\n]{3,}"|'[^'\n]{3,}'|[^\s,;}&]{3,})/gi
	}
];

export const REDACTED = '[redacted]';

/** JSON/object keys whose values must never be logged verbatim. */
const SECRET_KEY_RE =
	/(^|_|-|\.)(token|secret|password|passwd|pwd|apikey|api_key|access_key|authorization|cookie|credential|session)$/i;

export function isSecretKey(key: string): boolean {
	return SECRET_KEY_RE.test(key.toLowerCase()) || key.toLowerCase() === 'authorization';
}

/** Replace every known credential shape with `[redacted]`. */
export function redactString(input: string): string {
	let output = input;
	for (const { pattern } of SECRET_PATTERNS) {
		output = output.replace(pattern, (match, ...rest) => {
			// `assignment` keeps the key name so the log stays useful
			const label = rest[0];
			return typeof label === 'string' && rest.length > 1 ? `${label}=${REDACTED}` : REDACTED;
		});
	}
	return output;
}

/**
 * Deep redaction for structured data (log bindings, `tool_calls.debug`).
 * Returns a new value; non-plain objects (Date, Buffer, streams) are stringified
 * and pattern-redacted. Depth and array length are capped so a pathological
 * payload cannot hang the logger.
 */
export function redactValue<T>(
	value: T,
	options: { maxDepth?: number; maxArray?: number; maxString?: number } = {}
): unknown {
	const maxDepth = options.maxDepth ?? 6;
	const maxArray = options.maxArray ?? 50;
	const maxString = options.maxString ?? 2000;
	return redactInner(value, 0, { maxDepth, maxArray, maxString });
}

function redactInner(
	value: unknown,
	depth: number,
	limits: { maxDepth: number; maxArray: number; maxString: number }
): unknown {
	if (depth > limits.maxDepth) return '[truncated]';
	if (value === null || value === undefined) return value;
	if (typeof value === 'string') {
		const clipped =
			value.length > limits.maxString ? `${value.slice(0, limits.maxString)}…` : value;
		return redactString(clipped);
	}
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Error) {
		return {
			name: value.name,
			message: redactString(value.message),
			stack: redactString(value.stack ?? '')
		};
	}
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return `[binary ${value.byteLength}B]`;
	}
	if (Array.isArray(value)) {
		const items = value
			.slice(0, limits.maxArray)
			.map((item) => redactInner(item, depth + 1, limits));
		if (value.length > limits.maxArray) items.push(`[+${value.length - limits.maxArray} more]`);
		return items;
	}
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = isSecretKey(key) ? REDACTED : redactInner(item, depth + 1, limits);
		}
		return out;
	}
	return redactString(String(value));
}

/** Names of the patterns that matched, useful for the manifest import report. */
export function findSecretLike(input: string): string[] {
	const hits = new Set<string>();
	for (const { name, pattern } of SECRET_PATTERNS) {
		// clone: lastIndex would otherwise leak between calls for /g patterns
		if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test(input)) hits.add(name);
	}
	return [...hits];
}
