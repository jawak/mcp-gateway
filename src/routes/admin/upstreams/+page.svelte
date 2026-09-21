<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';

	let { data, form } = $props();
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">Upstreams</h1>
			<p class="text-sm text-zinc-500">
				{data.rows.length} configured
			</p>
		</div>
		<div class="flex gap-2">
			<Button href={resolve('/admin/templates')} variant="secondary">From template</Button>
			<Button href={resolve('/admin/upstreams/new')}>Add upstream</Button>
		</div>
	</div>

	{#if form?.error}
		<p
			class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
			role="alert"
		>
			{form.error}
		</p>
	{/if}

	{#if data.rows.length === 0}
		<EmptyState
			title="No upstream MCP servers yet"
			hint="Add one by hand, or start from a template."
		>
			{#snippet action()}
				<div class="flex gap-2">
					<Button href={resolve('/admin/upstreams/new')}>Add upstream</Button>
					<Button href={resolve('/admin/templates')} variant="secondary">Browse templates</Button>
				</div>
			{/snippet}
		</EmptyState>
	{:else}
		<Card>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs tracking-wide text-zinc-500 uppercase">
						<tr>
							<th class="pr-3 pb-2 font-medium">Name</th>
							<th class="pr-3 pb-2 font-medium">Transport</th>
							<th class="pr-3 pb-2 font-medium">Tools</th>
							<th class="pr-3 pb-2 font-medium">Health</th>
							<th class="pr-3 pb-2 font-medium">Warm</th>
							<th class="pb-2 font-medium">Actions</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-zinc-100 dark:divide-zinc-800">
						{#each data.rows as row (row.slug)}
							<tr class={row.enabled ? '' : 'opacity-60'}>
								<td class="py-2 pr-3">
									<a
										class="underline-offset-2 hover:underline"
										href={resolve('/admin/upstreams/[slug]', { slug: row.slug })}
									>
										{row.name}
									</a>
									<span class="block font-mono text-xs text-zinc-500">{row.slug}</span>
								</td>
								<td class="py-2 pr-3 text-xs"
									>{row.transport === 'stdio' ? 'local process' : 'remote HTTP'}</td
								>
								<td class="py-2 pr-3 tabular-nums">{row.toolsCount}</td>
								<td class="py-2 pr-3">
									<span class="flex items-center gap-2">
										<Badge status={row.status} dot title={row.error ?? undefined} />
										{#if row.latencyMs !== null}<span class="text-xs text-zinc-500"
												>{row.latencyMs} ms</span
											>{/if}
									</span>
								</td>
								<td class="py-2 pr-3 text-xs">{row.pin === 'pinned' ? 'kept warm' : 'on demand'}</td
								>
								<td class="py-2">
									<span class="flex flex-wrap gap-2">
										<form method="POST" action="?/toggle" use:enhance>
											<input type="hidden" name="id" value={row.id} />
											<input type="hidden" name="enabled" value={String(!row.enabled)} />
											<Button variant="ghost">{row.enabled ? 'Disable' : 'Enable'}</Button>
										</form>
										<form method="POST" action="?/check" use:enhance>
											<input type="hidden" name="slug" value={row.slug} />
											<Button variant="ghost">Check now</Button>
										</form>
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</Card>
	{/if}
</div>
