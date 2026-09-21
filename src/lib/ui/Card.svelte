<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		footer,
		children
	}: { title?: string; description?: string; footer?: Snippet; children: Snippet } = $props();
</script>

<section class="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
	{#if title || description}
		<header class="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
			{#if title}<h2 class="text-sm font-semibold">{title}</h2>{/if}
			{#if description}<p class="mt-0.5 text-xs text-zinc-500">{description}</p>{/if}
		</header>
	{/if}
	<div class="p-4">{@render children()}</div>
	{#if footer}
		<footer class="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
			{@render footer?.()}
		</footer>
	{/if}
</section>
