<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
		variant = 'primary',
		href,
		disabled = false,
		onclick,
		submit = false,
		name,
		value,
		title
	}: {
		children: Snippet;
		variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
		/** Renders a link instead of a button when set. */
		href?: string;
		disabled?: boolean;
		onclick?: () => void;
		submit?: boolean;
		name?: string;
		value?: string;
		title?: string;
	} = $props();

	const styles: Record<string, string> = {
		primary:
			'bg-zinc-900 text-zinc-50 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white',
		secondary:
			'border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800',
		danger: 'bg-rose-600 text-white hover:bg-rose-500',
		ghost: 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
	};
	const classes = $derived(
		`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
			styles[variant] ?? styles.secondary
		} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`
	);
</script>

{#if href}
	<!-- href is supplied by callers as an already-resolved path -->
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
	<a {href} {title} class={classes}>{@render children()}</a>
{:else}
	<button
		type={submit ? 'submit' : 'button'}
		{name}
		{value}
		{title}
		class={classes}
		{disabled}
		{onclick}
	>
		{@render children()}
	</button>
{/if}
