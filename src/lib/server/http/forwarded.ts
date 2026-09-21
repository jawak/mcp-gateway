/**
 * Client address resolution (T-03).
 *
 * We assume exactly one trusted proxy (Caddy) in front of the gateway: when
 * MCPGW_TRUST_PROXY is on we take the left-most `X-Forwarded-For` hop, otherwise
 * we ignore it entirely so a client cannot spoof its own IP for the per-key
 * rate limiter, IP allowlists or audit records.
 */
export function clientIp(
	headers: Pick<Headers, 'get'>,
	forwarded: string | undefined,
	trustProxy: boolean
): string {
	if (trustProxy && forwarded) {
		const first = forwarded.split(',')[0]?.trim();
		if (first) return first;
	}
	return headers.get('x-real-ip') ?? forwarded ?? 'unknown';
}

/** Parse one hop from a possibly-chained header value. */
export function firstHop(value: string | null): string | undefined {
	return value?.split(',')[0]?.trim() || undefined;
}
