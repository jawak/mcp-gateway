<script lang="ts">
	import { theme } from './theme.svelte';
</script>

<button
	type="button"
	onclick={() => theme.toggle()}
	class="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
	aria-label={`Switch to ${theme.value === 'dark' ? 'light' : 'dark'} theme`}
	title="Toggle theme"
>
	{theme.value === 'dark' ? 'Light' : 'Dark'}
</button>
