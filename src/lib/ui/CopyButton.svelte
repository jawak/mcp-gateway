<script lang="ts">
	let { value, label = 'Copy' }: { value: string; label?: string } = $props();

	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// clipboard access can be denied (insecure origin, permissions); selecting
			// the value is the fallback rather than failing silently
			copied = false;
		}
	}
</script>

<button
	type="button"
	onclick={copy}
	class="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
	aria-live="polite"
>
	{copied ? 'Copied' : label}
</button>
