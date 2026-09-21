<script lang="ts">
	import { resolve } from '$app/paths';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';

	let { data } = $props();

	const statusLabel: Record<string, string> = {
		active: 'Active',
		suspended: 'Suspended',
		revoked: 'Revoked'
	};
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">API keys</h1>
			<p class="text-sm text-zinc-500">
				One key per person or device. Values are shown once and cannot be recovered.
			</p>
		</div>
		<Button href={resolve('/admin/keys/new')}>New API key</Button>
	</div>

	{#if data.rows.length === 0}
		<EmptyState title="No API keys yet" hint="Issue one to connect your first client.">
			{#snippet action()}<Button href={resolve('/admin/keys/new')}>New API key</Button>{/snippet}
		</EmptyState>
	{:else}
		<Card>
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs tracking-wide text-zinc-500 uppercase">
						<tr>
							<th class="pr-3 pb-2 font-medium">Name</th>
							<th class="pr-3 pb-2 font-medium">Key</th>
							<th class="pr-3 pb-2 font-medium">Profile</th>
							<th class="pr-3 pb-2 font-medium">Status</th>
							<th class="pr-3 pb-2 font-medium">Last used</th>
							<th class="pb-2 font-medium">Expires</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-zinc-100 dark:divide-zinc-800">
						{#each data.rows as row (row.id)}
							<tr>
								<td class="py-2 pr-3">
									<a class="underline" href={resolve('/admin/keys/[id]', { id: row.id })}
										>{row.name}</a
									>
								</td>
								<td class="py-2 pr-3 font-mono text-xs">{row.prefix}…{row.tail}</td>
								<td class="py-2 pr-3">
									{row.profileName}
									{#if row.profileMissing}
										<span
											class="ml-1 text-xs text-amber-600"
											title="The profile is gone; this key cannot serve any tool.">broken</span
										>
									{/if}
								</td>
								<td class="py-2 pr-3">
									<Badge
										status={row.status === 'active'
											? 'healthy'
											: row.status === 'suspended'
												? 'degraded'
												: 'down'}
										label={statusLabel[row.status] ?? row.status}
									/>
								</td>
								<td class="py-2 pr-3 text-xs text-zinc-500"
									>{row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString() : 'never'}</td
								>
								<td class="py-2 text-xs {row.expired ? 'text-rose-600' : 'text-zinc-500'}">
									{row.expiresAt ? new Date(row.expiresAt).toLocaleDateString() : 'never'}
									{#if row.expired}(expired){/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</Card>
	{/if}
</div>
