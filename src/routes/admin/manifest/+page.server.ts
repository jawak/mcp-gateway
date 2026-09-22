import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	applyManifest,
	diffManifest,
	ManifestError,
	parseManifest,
	renderManifest
} from '$lib/server/registry/manifest';

export const load = (() => {
	// Export refuses to write a file that would carry a real credential. Correct, but
	// an operator who triggers it needs the reason in front of them — not an error
	// page, since the rest of this page is how they fix it.
	try {
		return { current: renderManifest(), exportError: undefined as string | undefined };
	} catch (error) {
		if (error instanceof ManifestError)
			return { current: '', exportError: error.issues.join(' · ') };
		throw error;
	}
}) satisfies PageServerLoad;

/**
 * Import and export `gateway.yaml` (T-38).
 *
 * The preview step is the point: an operator sees exactly what will change, including
 * which upstreams would be disabled, before anything is written. Secrets never appear
 * on either side of that preview.
 */
export const actions = {
	preview: async ({ request }) => {
		const data = await request.formData();
		const text = String(data.get('manifest') ?? '');
		try {
			const parsed = parseManifest(text);
			return {
				diff: diffManifest(parsed),
				parsed,
				endpointNote: 'no changes written yet',
				unconfigured: [] as Array<{ slug: string; missing: string[] }>
			};
		} catch (error) {
			if (error instanceof ManifestError) return fail(400, { errors: error.issues, text });
			throw error;
		}
	},

	apply: async ({ request, locals, getClientAddress }) => {
		const data = await request.formData();
		const text = String(data.get('manifest') ?? '');
		try {
			const parsed = parseManifest(text);
			const result = applyManifest(parsed, {
				actorId: locals.user?.id ?? null,
				ip: getClientAddress(),
				requestId: locals.sessionId
			});
			return {
				applied: true,
				diff: result,
				unconfigured: result.unconfigured,
				parsed: null,
				errors: undefined
			};
		} catch (error) {
			if (error instanceof ManifestError) return fail(400, { errors: error.issues, text });
			throw error;
		}
	}
} satisfies Actions;
