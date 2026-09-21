<script lang="ts">
	import { page } from '$app/state';

	let {
		total,
		perPage = 50,
		baseUrl
	}: { total: number; perPage?: number; baseUrl: string } = $props();

	const current = $derived(Number(page.url.searchParams.get('page') ?? '1') || 1);
	const pages = $derived(Math.max(1, Math.ceil(total / perPage)));
	const from = $derived(Math.min(total, (current - 1) * perPage + 1));
	const to = $derived(Math.min(total, current * perPage));

	function href(next: number): string {
		const url = new URL(page.url);
		url.searchParams.set('page', String(next));
		// hrefs stay relative to the current document: resolve() only accepts literal
		// routes, and this component is deliberately route-agnostic.
		return `${baseUrl}${url.search}`;
	}
</script>

{#if total > 0}
	<nav class="flex items-center justify-between text-sm text-zinc-500" aria-label="Pagination">
		<span>{from}–{to} of {total}</span>
		<span class="flex items-center gap-2">
			{#if current > 1}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a class="underline hover:text-zinc-900 dark:hover:text-zinc-100" href={href(current - 1)}
					>Previous</a
				>
			{/if}
			<span>page {current} / {pages}</span>
			{#if current < pages}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a class="underline hover:text-zinc-900 dark:hover:text-zinc-100" href={href(current + 1)}
					>Next</a
				>
			{/if}
		</span>
	</nav>
{/if}
