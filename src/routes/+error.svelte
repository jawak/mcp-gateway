<script lang="ts">
	import { page } from '$app/state';
	import Button from '$lib/ui/Button.svelte';

	// SvelteKit exposes the thrown error/status here; `message` is already sanitised
	// for production, so nothing internal leaks through this page.
	const status = $derived(page.status);
	const message = $derived(page.error?.message ?? 'Something went wrong.');
</script>

<div class="grid min-h-dvh place-content-center p-6 text-center">
	<p class="text-5xl font-semibold tabular-nums">{status}</p>
	<h1 class="mt-3 text-sm font-medium">{message}</h1>
	<p class="mt-2 text-sm text-zinc-500">
		{#if status === 403}
			Your account is not allowed to do that. Viewers can read everything but change nothing.
		{:else if status === 404}
			That page does not exist.
		{:else}
			If this keeps happening, check the server logs for the request id shown in the response
			headers.
		{/if}
	</p>
	<div class="mt-5 flex justify-center gap-2">
		<Button href="/admin" variant="primary">Back to dashboard</Button>
	</div>
</div>
