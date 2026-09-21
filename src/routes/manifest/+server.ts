import type { RequestHandler } from './$types';
import { renderManifest } from '$lib/server/registry/manifest';

/**
 * Machine-readable config export (T-20).
 *
 * Any signed-in user may read it: the manifest contains no secret values, only
 * references, and a viewer can already see the same references on the upstream
 * detail page. Writes stay admin-only.
 */
export const GET = (() =>
	new Response(renderManifest(), {
		headers: {
			'content-type': 'application/yaml; charset=utf-8',
			'cache-control': 'no-store'
		}
	})) satisfies RequestHandler;
