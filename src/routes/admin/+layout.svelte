<script lang="ts">
	import type { Snippet } from 'svelte';

	// `data` comes from +layout.server.ts; the shape is declared here rather than
	// via App.PageData so this file does not depend on generated types ordering
	let {
		data,
		children
	}: { data: { user: { email: string; role: string }; canWrite: boolean }; children: Snippet } =
		$props();
</script>

<div class="min-h-dvh bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
	<header
		class="flex items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800"
	>
		<span class="font-semibold">mcp-gateway</span>
		<span class="text-sm text-zinc-500">
			{data.user.email}
			<span class="ml-2 rounded bg-zinc-200 px-1.5 py-0.5 text-xs dark:bg-zinc-800"
				>{data.user.role}</span
			>
			{#if !data.canWrite}
				<span
					class="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
					>read-only</span
				>
			{/if}
		</span>
		<form method="POST" action="/logout">
			<button
				type="submit"
				class="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-200 dark:border-zinc-700 dark:hover:bg-zinc-800"
			>
				Sign out
			</button>
		</form>
	</header>
	<main class="p-6">
		{@render children()}
	</main>
</div>
