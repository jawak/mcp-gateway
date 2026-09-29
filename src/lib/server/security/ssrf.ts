/**
 * SSRF guard (T-05).
 *
 * Adding a remote upstream means the gateway will POST to a URL an operator
 * typed in, from inside the (often private) network it runs on. Without a guard,
 * `http://169.254.169.254/latest/meta-data/iam/` or an internal admin API becomes
 * a tool the model can call.
 *
 * Policy (defaults, PRD §Keamanan):
 *   - https only, unless the host is loopback (so a local MCP server works in dev)
 *   - no credentials in the URL (`https://user:pass@host`)
 *   - resolve the hostname first and reject if ANY answer is loopback, RFC1918,
 *     CGNAT, link-local (incl. the cloud metadata address), multicast or reserved
 *   - redirects are refused outright (`redirect: 'error'`) — otherwise a public
 *     host would 302 us into the private network
 *
 * Set MCPGW_ALLOW_PRIVATE_NETWORK=true on a fully private, self-hosted install
 * where the upstreams legitimately live on internal addresses.
 *
 * Known limitation (v2): validation and the request itself resolve DNS
 * separately, so a split-horizon host could theoretically rebind between the two.
 * Pinning the validated IP (custom agent + SNI override) is the fix.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

export class SsrfError extends Error {
	readonly url: string;
	readonly reason: string;

	constructor(url: string, reason: string) {
		super(`blocked request to ${url}: ${reason}`);
		this.name = 'SsrfError';
		this.url = url;
		this.reason = reason;
	}
}

export type Resolver = (host: string) => Promise<Array<{ address: string }>>;

export type SsrfOptions = {
	/** Allow loopback targets (127.0.0.0/8, ::1). Default true (dev + local MCP). */
	allowLoopback?: boolean;
	/** Allow RFC1918 / CGNAT / ULA ranges. Default false. */
	allowPrivateNetwork?: boolean;
	/** Inject for tests; defaults to `dns.lookup`. */
	resolve?: Resolver;
};

const LOOPBACK_V4 = (octets: number[]): boolean => octets[0] === 127;
const PRIVATE_V4 = (octets: number[]): boolean => {
	const [a = 0, b = 0] = octets;
	if (a === 10) return true; // 10/8
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
	if (a === 192 && b === 168) return true; // 192.168/16
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
	if (a === 0) return true; // 0.0.0.0/8 "this host"
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a === 192 && b === 0) return true; // IETF protocol assignments
	if (a === 198 && b === 51) return true; // TEST-NET-2
	if (a === 203 && b === 0) return true; // TEST-NET-3
	return false;
};
const LINK_LOCAL_V4 = (octets: number[]): boolean => octets[0] === 169 && octets[1] === 254;
const MULTICAST_OR_RESERVED_V4 = (octets: number[]): boolean => (octets[0] ?? 0) >= 224;

/** Classify an IP literal. */
export function classifyAddress(
	address: string
): 'loopback' | 'private' | 'link-local' | 'multicast' | 'public' {
	const version = isIP(address);
	if (version === 4) {
		const octets = address.split('.').map((part) => Number.parseInt(part, 10));
		if (LINK_LOCAL_V4(octets)) return 'link-local';
		if (LOOPBACK_V4(octets)) return 'loopback';
		if (MULTICAST_OR_RESERVED_V4(octets)) return 'multicast';
		if (PRIVATE_V4(octets)) return 'private';
		return 'public';
	}
	const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
	if (normalized === '::1') return 'loopback';
	if (normalized === '::') return 'private';
	const mapped = /::ffff:((?:\d{1,3}\.){3}\d{1,3})/.exec(normalized);
	if (mapped) return classifyAddress(mapped[1] as string);
	const first = Number.parseInt(normalized.split(':')[0] ?? '0', 16);
	if (
		normalized.startsWith('fe8') ||
		normalized.startsWith('fe9') ||
		normalized.startsWith('fea') ||
		normalized.startsWith('feb')
	)
		return 'link-local';
	if ((first & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 ULA
	if (normalized.startsWith('ff')) return 'multicast';
	return 'public';
}

const LOCAL_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

/**
 * Validate a URL that the gateway is about to request. Returns the parsed URL and
 * the addresses it resolves to.
 */
export async function assertUrlAllowed(
	rawUrl: string,
	options: SsrfOptions = {}
): Promise<{ url: URL; addresses: string[] }> {
	const allowPrivate = options.allowPrivateNetwork ?? false;
	const allowLoopback = options.allowLoopback ?? true;

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new SsrfError(rawUrl, 'not a valid absolute URL');
	}
	if (url.username || url.password)
		throw new SsrfError(rawUrl, 'credentials in the URL are not allowed');
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new SsrfError(rawUrl, `unsupported protocol ${url.protocol}`);
	}

	const host = url.hostname.replace(/^\[|\]$/g, '');
	const isLocalName = LOCAL_HOSTNAMES.has(host);
	const literal = isIP(host);

	if (
		url.protocol === 'http:' &&
		!(isLocalName || (literal && classifyAddress(host) === 'loopback')) &&
		!(literal && allowPrivate && classifyAddress(host) === 'private')
	) {
		throw new SsrfError(
			rawUrl,
			'http:// is refused; use https:// (loopback is exempt for local development, or private IP literals when MCPGW_ALLOW_PRIVATE_NETWORK=true)'
		);
	}

	let addresses: string[];
	if (literal) {
		addresses = [host];
	} else {
		const resolve =
			options.resolve ?? ((h: string) => dns.lookup(h, { all: true, verbatim: true }));
		try {
			addresses = (await resolve(host)).map((entry) => entry.address);
		} catch (cause) {
			throw new SsrfError(rawUrl, `DNS lookup failed: ${(cause as Error).message}`);
		}
	}
	if (addresses.length === 0) throw new SsrfError(rawUrl, 'DNS returned no addresses');

	if (isLocalName) {
		// localhost must still resolve to loopback, never to a routable host
		const foreign = addresses.filter((address) => classifyAddress(address) !== 'loopback');
		if (foreign.length > 0 && !allowPrivate) {
			throw new SsrfError(rawUrl, `localhost resolved to non-loopback ${foreign.join(', ')}`);
		}
		return { url, addresses };
	}

	for (const address of addresses) {
		const kind = classifyAddress(address);
		if (kind === 'loopback' && !allowLoopback)
			throw new SsrfError(rawUrl, `${address} is loopback`);
		if (kind === 'link-local') {
			throw new SsrfError(
				rawUrl,
				`${address} is link-local (cloud metadata endpoints are blocked)`
			);
		}
		if (kind === 'multicast') throw new SsrfError(rawUrl, `${address} is multicast or reserved`);
		if (kind === 'private' && !allowPrivate) {
			throw new SsrfError(
				rawUrl,
				`${address} is a private range (set MCPGW_ALLOW_PRIVATE_NETWORK=true if this is intentional)`
			);
		}
	}
	return { url, addresses };
}

/**
 * Same shape as the MCP SDK's `FetchLike` (and of `globalThis.fetch` for our
 * uses), so a validated fetch can be handed to any client transport directly.
 */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` that refuses unsafe destinations, redirects and hangs. Drop-in for the
 * MCP remote client transport.
 */
export function createSsrfSafeFetch(options: SsrfOptions & { timeoutMs?: number } = {}): FetchLike {
	const timeoutMs = options.timeoutMs ?? 15_000;
	return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
		await assertUrlAllowed(input.toString(), options);
		const signal = AbortSignal.any(
			[init.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean) as AbortSignal[]
		);
		return fetch(input, { ...init, redirect: 'error', signal });
	};
}
