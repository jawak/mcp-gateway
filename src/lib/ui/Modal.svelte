<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fly } from 'svelte/transition';

	let {
		open = $bindable(false),
		title,
		children,
		footer
	}: { open?: boolean; title: string; children: Snippet; footer?: Snippet } = $props();

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') open = false;
	}

	function onBackdrop(event: MouseEvent) {
		if (event.target === event.currentTarget) open = false;
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div
		class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
		onclick={onBackdrop}
		role="presentation"
		transition:fly={{ duration: 120 }}
	>
		<div
			role="dialog"
			aria-modal="true"
			aria-label={title}
			class="w-full max-w-lg rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
		>
			<header
				class="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800"
			>
				<h2 class="text-sm font-semibold">{title}</h2>
				<button
					type="button"
					onclick={() => (open = false)}
					class="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
					aria-label="Close"
				>
					✕
				</button>
			</header>
			<div class="p-4">{@render children()}</div>
			{#if footer}
				<footer
					class="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800"
				>
					{@render footer?.()}
				</footer>
			{/if}
		</div>
	</div>
{/if}
