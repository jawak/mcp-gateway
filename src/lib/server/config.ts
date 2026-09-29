/**
 * Environment configuration (T-03).
 *
 * Rules:
 *  - Nothing is validated at import time: SvelteKit imports server modules
 *    during `vite dev`, and a missing var must not break tooling.
 *  - `loadConfig()` is memoised and fail-fast. It throws a single, aggregated
 *    `ConfigError` naming every offending variable, so an operator fixes the
 *    whole `.env` in one pass instead of one error per restart.
 *  - In production (`NODE_ENV=production`) the secrets are mandatory. In dev
 *    they are generated per-process and loudly warned about, so `bun run dev`
 *    works on a fresh clone.
 *
 * Full variable reference lives in `.env.example`.
 */
import { hkdfSync } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
// Inlined by the bundler, so the built server knows its own version without
// depending on how it was launched (bun build/server.js has no npm_* env).
import pkg from '../../../package.json';

export type Mode = 'strict' | 'lenient';

export type Config = {
	appName: string;
	version: string;
	isProduction: boolean;
	/** 32-byte master key (from MCPGW_MASTER_KEY hex, or an ephemeral dev key). */
	masterKey: Uint8Array;
	masterKeyIsEphemeral: boolean;
	/** Key version 1 by default; bump to force re-sealing of stored secrets. */
	masterKeyVersion: number;
	publicUrl: URL;
	origin: string;
	cookieSecret: Uint8Array;
	metricsToken: string | undefined;
	admin: { email: string | undefined; password: string | undefined };
	dataDir: string;
	port: number;
	host: string;
	logLevel: string;
	trustProxy: boolean;
	/** Let remote upstreams resolve to RFC1918/CGNAT (private installs only). */
	allowPrivateNetwork: boolean;
	/** Skip upstream certificate verification. */
	allowInsecureTls: boolean;
	/** Allow a plain-http public URL for hosts the private-host check would refuse. */
	allowHttp: boolean;
	upstreamConnectTimeoutMs: number;
	/** How long the worker waits for the gateway to migrate before giving up. */
	workerWaitMs: number;
	gracefulShutdownMs: number;
	maxBodyBytes: number;
	healthIntervalMs: number;
	catalogTtlMs: number;
	sessionTtlMs: number;
	maxLiveUpstreams: number;
	upstreamTimeoutMs: number;
	upstreamMaxTimeoutMs: number;
	toolPayloadLimitBytes: number;
	debugPayload: boolean;
	debugMaxBytes: number;
	retention: { toolCallsDays: number; auditDays: number; healthDays: number; backups: number };
	timeZone: string;
};

export class ConfigError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(
			`invalid configuration:\n  - ${issues.join('\n  - ')}\n\nSee .env.example for the documented variables.`
		);
		this.name = 'ConfigError';
		this.issues = issues;
	}
}

const hex64 = /^[0-9a-fA-F]{64}$/;

const positiveSeconds = z.coerce.number().int().min(1).max(86_400);
const positiveMinutes = z.coerce.number().int().min(1).max(1440);
const positiveDays = z.coerce.number().int().min(1).max(3650);
const positiveMs = z.coerce.number().int().min(100).max(3_600_000);

const envSchema = z.object({
	// Presence is enforced per-mode below (strict = required); the schema only
	// validates the shape when a value is supplied.
	MCPGW_MASTER_KEY: z
		.string()
		.regex(hex64, 'must be exactly 64 hex characters (32 bytes): openssl rand -hex 32')
		.optional(),
	MCPGW_PUBLIC_URL: z
		.string()
		.refine(isHttpUrl, 'must be an absolute http(s) URL, e.g. https://mcp.example.com')
		.optional(),
	MCPGW_MASTER_KEY_VERSION: z.coerce.number().int().min(1).max(255).default(1),
	MCPGW_COOKIE_SECRET: z
		.string()
		.min(32, 'must be at least 32 characters if set explicitly')
		.optional(),
	MCPGW_METRICS_TOKEN: z.string().min(16, 'must be at least 16 characters if set').optional(),
	MCPGW_ADMIN_EMAIL: z.string().min(1).refine(isEmail, 'must be a valid email address').optional(),
	// Strength is validated where the value is used (`db/seed.ts`, enforced by
	// `hashPassword`), not here: this is a bootstrap input, not a runtime setting,
	// and validating it in the whole-process schema let a weak bootstrap password
	// stop unrelated processes (the worker) from starting at all.
	MCPGW_ADMIN_PASSWORD: z.string().max(512, 'must be at most 512 characters').optional(),
	MCPGW_DATA_DIR: z.string().min(1).default('./data'),
	MCPGW_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
	MCPGW_HOST: z.string().min(1).default('0.0.0.0'),
	MCPGW_LOG_LEVEL: z
		.string()
		.refine(
			(v) =>
				['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(v.toLowerCase()),
			'must be one of fatal|error|warn|info|debug|trace|silent'
		)
		.default('info'),
	MCPGW_TRUST_PROXY: truthyDefault(true),
	MCPGW_ALLOW_PRIVATE_NETWORK: truthyDefault(false),
	MCPGW_ALLOW_INSECURE_TLS: truthyDefault(false),
	MCPGW_ALLOW_HTTP: truthyDefault(false),
	MCPGW_UPSTREAM_CONNECT_TIMEOUT_S: positiveSeconds.default(10),
	MCPGW_WORKER_WAIT_S: positiveSeconds.default(60),
	MCPGW_SHUTDOWN_TIMEOUT_S: positiveSeconds.default(30),
	MCPGW_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(33_554_432).default(1_048_576),
	MCPGW_HEALTH_INTERVAL_S: positiveSeconds.default(30),
	MCPGW_CATALOG_TTL_S: positiveSeconds.default(60),
	MCPGW_SESSION_TTL_MIN: positiveMinutes.default(30),
	MCPGW_MAX_LIVE_UPSTREAMS: z.coerce.number().int().min(1).max(200).default(20),
	MCPGW_UPSTREAM_TIMEOUT_MS: positiveMs.default(60_000),
	MCPGW_UPSTREAM_MAX_TIMEOUT_MS: positiveMs.default(300_000),
	MCPGW_TOOL_PAYLOAD_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
	MCPGW_DEBUG: truthyDefault(false),
	MCPGW_DEBUG_MAX_BYTES: z.coerce.number().int().min(256).max(1_048_576).default(16_384),
	MCPGW_RETENTION_TOOL_CALLS_DAYS: positiveDays.default(30),
	MCPGW_RETENTION_AUDIT_DAYS: positiveDays.default(180),
	MCPGW_RETENTION_HEALTH_DAYS: positiveDays.default(7),
	MCPGW_RETENTION_BACKUPS: positiveDays.default(14),
	MCPGW_TZ: z.string().min(2).default('UTC')
});

type EnvInput = Record<string, string | undefined>;

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.host);
	} catch {
		return false;
	}
}

function isEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/**
 * Whether a plain-http public URL may be served to this hostname in production:
 * `localhost`, or an IP literal (brackets stripped here — Bun keeps them in
 * `url.hostname`) in the loopback, RFC1918/CGNAT, link-local or ULA ranges,
 * mirroring the SSRF guard's `classifyAddress`, or an IPv4-mapped IPv6 address
 * decoded back to its v4 identity. Multicast and public hosts are not private,
 * so plain http to them stays behind the `MCPGW_ALLOW_HTTP` opt-in.
 */
function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host === 'localhost.localdomain') return true;
	const version = isIP(host);
	if (version === 4) {
		const octets = host.split('.').map((part) => Number.parseInt(part, 10));
		const [a = 0, b = 0] = octets;
		if (a === 127) return true; // loopback 127/8
		if (a === 169 && b === 254) return true; // link-local
		if (a === 10) return true; // 10/8
		if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
		if (a === 192 && b === 168) return true; // 192.168/16
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
		if (a === 0) return true; // 0.0.0.0/8 "this network"
		if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
		if (a === 192 && b === 0) return true; // IETF protocol assignments
		if (a === 198 && b === 51) return true; // TEST-NET-2
		if (a === 203 && b === 0) return true; // TEST-NET-3
		return false;
	}
	if (version === 6) {
		if (host === '::1' || host === '::') return true; // loopback / unspecified
		if (host.startsWith('::ffff:')) {
			const tail = host.slice('::ffff:'.length).split(':');
			if (tail.length === 1 && tail[0].includes('.')) return isPrivateHost(tail[0]);
			if (tail.length === 2) {
				const hextets = tail.map((hextet) => Number.parseInt(hextet, 16));
				if (hextets.some(Number.isNaN)) return false;
				const octets = [
					(hextets[0] >> 8) & 0xff,
					hextets[0] & 0xff,
					(hextets[1] >> 8) & 0xff,
					hextets[1] & 0xff
				];
				return isPrivateHost(octets.map(String).join('.'));
			}
			return false;
		}
		const first = Number.parseInt(host.split(':')[0] ?? '0', 16);
		if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
		if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
		return false;
	}
	return false;
}

/** `1|true|yes|on` (case-insensitive); anything else false, with a configurable default for unset. */
function truthyDefault(fallback: boolean) {
	return z
		.string()
		.optional()
		.transform((value) => {
			if (value === undefined || value === '') return fallback;
			return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
		});
}

function toIssues(error: z.ZodError): string[] {
	return error.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join('.') : 'environment';
		return `${path}: ${issue.message}`;
	});
}

/** Derive a domain-separated subkey from the master key. */
export function deriveKey(masterKey: Uint8Array, info: string, length = 32): Uint8Array {
	return new Uint8Array(
		hkdfSync('sha256', masterKey, new Uint8Array(), new TextEncoder().encode(info), length)
	);
}

export type LoadConfigOptions = {
	mode?: Mode;
	env?: EnvInput;
	/** Injected in tests to keep derivation deterministic. */
	warn?: (message: string) => void;
};

let cached: { key: string; config: Config } | undefined;

/**
 * Treat an empty environment value as "not set".
 *
 * A copied `.env.example` contains lines like `MCPGW_METRICS_TOKEN=` for the
 * optional variables, and an empty string is not `undefined` — without this, the
 * very first thing a new operator does (copy the example file) fails validation
 * on `min(16)`/`min(32)`, and `z.coerce.number()` would turn `MCPGW_PORT=` into 0.
 * Blank means "I did not configure this", which is exactly what `undefined` means
 * to the schema and its defaults.
 */
function normalizeEnv(env: EnvInput): EnvInput {
	const out: EnvInput = {};
	for (const [key, value] of Object.entries(env)) {
		out[key] = value === undefined || value.trim() === '' ? undefined : value;
	}
	return out;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
	const raw = options.env ?? process.env;
	const isProduction = (raw.NODE_ENV ?? '').toLowerCase() === 'production';
	const mode: Mode = options.mode ?? (isProduction ? 'strict' : 'lenient');
	const warn = options.warn ?? ((message: string) => console.warn(`[config] ${message}`));

	const parsed = envSchema.safeParse(normalizeEnv(raw));
	if (!parsed.success) throw new ConfigError(toIssues(parsed.error));
	const e = parsed.data;

	let masterKey: Uint8Array;
	let masterKeyIsEphemeral = false;
	if (e.MCPGW_MASTER_KEY) {
		masterKey = new Uint8Array(Buffer.from(e.MCPGW_MASTER_KEY, 'hex'));
	} else if (mode === 'strict') {
		throw new ConfigError([
			'MCPGW_MASTER_KEY: required in production — generate one with `openssl rand -hex 32`'
		]);
	} else {
		masterKey = new Uint8Array(crypto.getRandomValues(new Uint8Array(32)));
		masterKeyIsEphemeral = true;
		warn(
			'MCPGW_MASTER_KEY is unset — using an ephemeral key for this process. ' +
				'Secrets sealed now cannot be opened after a restart. Set it in .env for real use.'
		);
	}

	let publicUrl: URL;
	if (e.MCPGW_PUBLIC_URL) {
		publicUrl = new URL(e.MCPGW_PUBLIC_URL);
	} else if (mode === 'strict') {
		throw new ConfigError([
			'MCPGW_PUBLIC_URL: required in production — the public origin of this gateway'
		]);
	} else {
		publicUrl = new URL(`http://localhost:${e.MCPGW_PORT}`);
		warn(`MCPGW_PUBLIC_URL is unset — assuming ${publicUrl.origin} (dev only).`);
	}

	if (
		publicUrl.protocol === 'http:' &&
		isProduction &&
		!isPrivateHost(publicUrl.hostname) &&
		!e.MCPGW_ALLOW_HTTP
	) {
		throw new ConfigError([
			`MCPGW_PUBLIC_URL: ${publicUrl.origin} uses http:// for a host that is not private or loopback — TLS is required on public hosts; set MCPGW_ALLOW_HTTP=true if this is intentional`
		]);
	}

	if (e.MCPGW_UPSTREAM_TIMEOUT_MS > e.MCPGW_UPSTREAM_MAX_TIMEOUT_MS) {
		throw new ConfigError([
			`MCPGW_UPSTREAM_TIMEOUT_MS (${e.MCPGW_UPSTREAM_TIMEOUT_MS}) cannot exceed MCPGW_UPSTREAM_MAX_TIMEOUT_MS (${e.MCPGW_UPSTREAM_MAX_TIMEOUT_MS})`
		]);
	}

	const cookieSecret = e.MCPGW_COOKIE_SECRET
		? new Uint8Array(Buffer.from(e.MCPGW_COOKIE_SECRET.padEnd(64, '.').slice(0, 32), 'utf8'))
		: deriveKey(masterKey, 'mcp-gateway/cookie', 32);

	return {
		appName: 'mcp-gateway',
		version: pkg.version,
		isProduction,
		masterKey,
		masterKeyIsEphemeral,
		masterKeyVersion: e.MCPGW_MASTER_KEY_VERSION,
		publicUrl,
		origin: publicUrl.origin,
		cookieSecret,
		metricsToken: e.MCPGW_METRICS_TOKEN,
		admin: { email: e.MCPGW_ADMIN_EMAIL, password: e.MCPGW_ADMIN_PASSWORD },
		dataDir: e.MCPGW_DATA_DIR,
		port: e.MCPGW_PORT,
		host: e.MCPGW_HOST,
		logLevel: e.MCPGW_LOG_LEVEL.toLowerCase(),
		trustProxy: e.MCPGW_TRUST_PROXY,
		allowPrivateNetwork: e.MCPGW_ALLOW_PRIVATE_NETWORK,
		allowInsecureTls: e.MCPGW_ALLOW_INSECURE_TLS,
		allowHttp: e.MCPGW_ALLOW_HTTP,
		upstreamConnectTimeoutMs: e.MCPGW_UPSTREAM_CONNECT_TIMEOUT_S * 1000,
		workerWaitMs: e.MCPGW_WORKER_WAIT_S * 1000,
		gracefulShutdownMs: e.MCPGW_SHUTDOWN_TIMEOUT_S * 1000,
		maxBodyBytes: e.MCPGW_MAX_BODY_BYTES,
		healthIntervalMs: e.MCPGW_HEALTH_INTERVAL_S * 1000,
		catalogTtlMs: e.MCPGW_CATALOG_TTL_S * 1000,
		sessionTtlMs: e.MCPGW_SESSION_TTL_MIN * 60_000,
		maxLiveUpstreams: e.MCPGW_MAX_LIVE_UPSTREAMS,
		upstreamTimeoutMs: e.MCPGW_UPSTREAM_TIMEOUT_MS,
		upstreamMaxTimeoutMs: e.MCPGW_UPSTREAM_MAX_TIMEOUT_MS,
		toolPayloadLimitBytes: e.MCPGW_TOOL_PAYLOAD_LIMIT_BYTES,
		debugPayload: e.MCPGW_DEBUG,
		debugMaxBytes: e.MCPGW_DEBUG_MAX_BYTES,
		retention: {
			toolCallsDays: e.MCPGW_RETENTION_TOOL_CALLS_DAYS,
			auditDays: e.MCPGW_RETENTION_AUDIT_DAYS,
			healthDays: e.MCPGW_RETENTION_HEALTH_DAYS,
			backups: e.MCPGW_RETENTION_BACKUPS
		},
		timeZone: e.MCPGW_TZ
	};
}

/**
 * Process-wide config, created on first use. Pass `{ mode: 'lenient' }` to
 * `loadConfig()` directly in tests that need an isolated instance.
 */
export function getConfig(): Config {
	const key = JSON.stringify(process.env.MCPGW_ENV_KEY ?? 'default');
	if (!cached || cached.key !== key) cached = { key, config: loadConfig() };
	return cached.config;
}

/** Test hook: drop the memoised config. */
export function resetConfigCache(): void {
	cached = undefined;
}
