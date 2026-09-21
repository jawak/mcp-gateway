import type { PageLoad } from './$types';

/** `?next=` is echoed back into the form; the server re-validates it. */
export const load = (({ url }) => ({
	next: url.searchParams.get('next') ?? '/admin'
})) satisfies PageLoad;
