/**
 * Static asset serving for the custom Bun entrypoint (T-02).
 *
 * `@sveltejs/adapter-node` normally serves `build/client` with sirv; because we
 * run our own `node:http` server we serve them with `Bun.file` instead, which
 * gives us content-type sniffing, range requests and etags for free.
 *
 * SvelteKit's `_app/immutable/*` assets are content-hashed → immutable cache.
 * Anything else is revalidated. Missing files return `undefined` so the request
 * can fall through to SvelteKit.
 */
import path from 'node:path';

const IMMUTABLE_PREFIX = '/_app/immutable/';

export type StaticOptions = {
	/** Absolute path of `build/client`. */
	root: string;
	/** Extra cache-control for non-immutable files. */
	maxAge?: number;
};

export async function serveStatic(
	request: Request,
	opts: StaticOptions
): Promise<Response | undefined> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return undefined;

	const pathname = decodeURIComponent(new URL(request.url).pathname);
	if (pathname.includes('\0')) return undefined;

	const target = path.join(opts.root, path.normalize(pathname));
	const relative = path.relative(opts.root, target);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;

	const file = Bun.file(target);
	if (!(await file.exists())) return undefined;

	const immutable = pathname.startsWith(IMMUTABLE_PREFIX);
	// Bun.File exposes size/lastModified as properties (not promises)
	const mtime = file.lastModified;
	const headers = new Headers({
		'content-type': file.type || 'application/octet-stream',
		'cache-control': immutable
			? 'public, max-age=31536000, immutable'
			: `public, max-age=${opts.maxAge ?? 600}, must-revalidate`,
		'last-modified': new Date(mtime).toUTCString()
	});
	const etag = `"${file.size.toString(16)}-${Math.floor(mtime).toString(16)}"`;
	headers.set('etag', etag);
	if (request.headers.get('if-none-match') === etag)
		return new Response(null, { status: 304, headers });

	return new Response(request.method === 'HEAD' ? null : file, { status: 200, headers });
}
