/**
 * Runtime configuration (minimal for T-02).
 * Replaced by the validated Zod loader in T-03 (`src/lib/server/config.ts`);
 * until then nothing here may throw at import time so the server can boot
 * before secrets exist.
 */
// Bundled/inlined by Bun & Vite, so the built server never reads the filesystem.
import pkg from '../../../package.json';

function int(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === '') return fallback;
	return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export const runtime = {
	appName: pkg.name,
	version: pkg.version,
	port: int(process.env.MCPGW_PORT, 8080),
	host: process.env.MCPGW_HOST || '0.0.0.0',
	dataDir: process.env.MCPGW_DATA_DIR || './data',
	trustProxy: bool(process.env.MCPGW_TRUST_PROXY, true),
	gracefulShutdownMs: int(process.env.MCPGW_SHUTDOWN_TIMEOUT_S, 30) * 1000,
	maxBodyBytes: int(process.env.MCPGW_MAX_BODY_BYTES, 1_048_576)
};

/**
 * Best-effort client IP. Only the left-most `X-Forwarded-For` hop is trusted,
 * and only when MCPGW_TRUST_PROXY is enabled (we assume exactly one proxy hop,
 * e.g. Caddy in front of the gateway).
 */
export function clientIp(
	headers: Pick<Headers, 'get'>,
	forwarded: string | undefined,
	trustProxy = runtime.trustProxy
): string {
	if (trustProxy && forwarded) {
		const first = forwarded.split(',')[0]?.trim();
		if (first) return first;
	}
	return headers.get('x-real-ip') ?? forwarded ?? 'unknown';
}
