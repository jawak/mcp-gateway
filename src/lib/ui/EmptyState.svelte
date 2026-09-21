<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, hint, action }: { title: string; hint?: string; action?: Snippet } = $props();
</script>

<div
	class="flex flex-col items-start gap-3 rounded-lg border border-dashed border-zinc-300 p-6 dark:border-zinc-700"
>
	<div>
		<p class="text-sm font-medium">{title}</p>
		{#if hint}<p class="mt-1 text-sm text-zinc-500">{hint}</p>{/if}
	</div>
	{#if action}{@render action?.()}{/if}
</div>
