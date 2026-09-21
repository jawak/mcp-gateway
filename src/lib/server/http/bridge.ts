/**
 * Minimal web ⇄ node:http bridge.
 *
 * The MCP endpoint is implemented with Web-standard `Request`/`Response`
 * (required by `WebStandardStreamableHTTPServerTransport`), while SvelteKit's
 * `@sveltejs/adapter-node` / `Server` API is driven from a `node:http` server.
 * This module converts in both directions so one server can serve both.
 *
 * Deliberately small: no compression (Caddy terminates TLS and compresses),
 * no HTTP/2, no expect-continue.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Thrown when a request body exceeds the configured limit. */
export class PayloadTooLargeError extends Error {
	readonly limitBytes: number;

	constructor(limitBytes: number) {
		super(`request body exceeds ${limitBytes} bytes`);
		this.name = 'PayloadTooLargeError';
		this.limitBytes = limitBytes;
	}
}

/** Build the absolute URL of an incoming request. */
export function requestUrl(req: IncomingMessage, trustProxy = false): URL {
	const forwardedHost = trustProxy ? req.headers['x-forwarded-host'] : undefined;
	const host = (typeof forwardedHost === 'string' ? forwardedHost : undefined) ?? req.headers.host;
	if (!host) throw new Error('request without Host header');
	const forwardedProto = trustProxy ? req.headers['x-forwarded-proto'] : undefined;
	const fromProxy =
		typeof forwardedProto === 'string' ? forwardedProto.split(',')[0]?.trim() : undefined;
	const proto = fromProxy ?? ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
	return new URL(req.url ?? '/', `${proto}://${host}`);
}

/**
 * Convert a `node:http` request into a web `Request`.
 * Body-less methods (GET/HEAD/DELETE/OPTIONS) get no body, as the Fetch spec
 * requires. Bodies are streamed and capped at `maxBodyBytes`.
 */
export async function toWebRequest(
	req: IncomingMessage,
	opts: { trustProxy?: boolean; maxBodyBytes?: number } = {}
): Promise<Request> {
	const { trustProxy = false, maxBodyBytes } = opts;
	const url = requestUrl(req, trustProxy).toString();
	const method = (req.method ?? 'GET').toUpperCase();
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
	}

	const init: RequestInit & { duplex?: 'half' } = { method, headers };
	if (method !== 'GET' && method !== 'HEAD') {
		const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
		if (maxBodyBytes && Number.isFinite(declared) && declared > maxBodyBytes) {
			throw new PayloadTooLargeError(maxBodyBytes);
		}
		init.body = toBodyStream(req, maxBodyBytes) as unknown as BodyInit;
		init.duplex = 'half';
	}
	return new Request(url, init);
}

function toBodyStream(req: IncomingMessage, maxBodyBytes?: number): ReadableStream<Uint8Array> {
	let received = 0;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			req.on('data', (chunk: Buffer) => {
				received += chunk.length;
				if (maxBodyBytes && received > maxBodyBytes) {
					const error = new PayloadTooLargeError(maxBodyBytes);
					controller.error(error);
					req.destroy(error);
					return;
				}
				controller.enqueue(new Uint8Array(chunk));
			});
			req.on('end', () => controller.close());
			req.on('error', (error) => controller.error(error));
			req.on('aborted', () => controller.error(new Error('request aborted')));
		},
		cancel(reason) {
			req.destroy(reason instanceof Error ? reason : undefined);
		}
	});
}

/** Pipe a web `Response` (including long-lived SSE streams) into node:http. */
export async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
	if (res.headersSent) return;
	res.statusCode = response.status;
	// node:http calls it statusMessage, and only accepts it before headers are sent
	res.statusMessage = response.statusText;
	const setCookies: string[] = [];
	response.headers.forEach((value, name) => {
		if (name.toLowerCase() === 'set-cookie') setCookies.push(value);
		else res.setHeader(name, value);
	});
	if (setCookies.length > 0) res.setHeader('set-cookie', setCookies);

	if (!response.body || response.body.locked) {
		res.end();
		return;
	}

	res.on('close', () => {
		if (response.body && !response.body.locked)
			void response.body.cancel(new Error('client closed'));
	});

	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', resolve));
		}
		res.end();
	} catch (error) {
		if (!res.writableEnded) res.destroy(error as Error);
	} finally {
		reader.releaseLock();
	}
}

/** Fallback error response for failures that happen before/inside routing. */
export function writePlainError(res: ServerResponse, status: number, message: string): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.statusCode = status;
	res.setHeader('content-type', 'text/plain; charset=utf-8');
	res.end(message);
}

/** JSON response helper for gateway-owned endpoints. */
export function json(
	data: unknown,
	init: { status?: number; headers?: Record<string, string> } = {}
): Response {
	return new Response(JSON.stringify(data), {
		status: init.status ?? 200,
		headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers }
	});
}
