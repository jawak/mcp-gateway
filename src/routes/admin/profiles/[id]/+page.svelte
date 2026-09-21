<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';

	let { data, form } = $props();
	const saved = $derived(page.url.searchParams.get('saved') === '1');
	let confirmDelete = $state(false);
</script>

<div class="space-y-4">
	<nav class="text-sm text-zinc-500">
		<a class="underline" href={resolve('/admin/profiles')}>Profiles</a> / {data.profile.name}
	</nav>

	<div>
		<h1 class="text-lg font-semibold">{data.profile.name}</h1>
		<p class="text-sm text-zinc-500">
			~{data.totalTools} tools visible · {data.profile.rateLimitRpm} requests/min ·
			{data.profile.dailyCallQuota || 'unlimited'} calls/day · {data.profile.maxConcurrency} concurrent
		</p>
	</div>

	{#if saved}
		<p
			class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
		>
			Saved.
		</p>
	{/if}
	{#if form?.error}
		<p
			class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
			role="alert"
		>
			{form.error}
		</p>
	{/if}

	<Card
		title="Scope and tool filters"
		description="Patterns match the qualified name the client sees (github__create_pr). Deny wins over allow."
	>
		<form method="POST" action="?/save" class="space-y-3" use:enhance>
			<div class="grid gap-3 sm:grid-cols-3">
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Requests / min</span>
					<input
						name="rateLimitRpm"
						type="number"
						min="1"
						value={data.profile.rateLimitRpm}
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Calls / day (0 = unlimited)</span>
					<input
						name="dailyCallQuota"
						type="number"
						min="0"
						value={data.profile.dailyCallQuota}
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Max concurrent calls</span>
					<input
						name="maxConcurrency"
						type="number"
						min="1"
						value={data.profile.maxConcurrency}
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
			</div>

			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs tracking-wide text-zinc-500 uppercase">
						<tr>
							<th class="pr-2 pb-1 font-medium">In scope</th>
							<th class="pr-2 pb-1 font-medium">Upstream</th>
							<th class="pr-2 pb-1 font-medium">Allow</th>
							<th class="pr-2 pb-1 font-medium">Deny</th>
							<th class="pb-1 font-medium">Visible</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-zinc-100 dark:divide-zinc-800">
						{#each data.rows as row (row.slug)}
							<tr>
								<td class="py-2 pr-2">
									<input
										type="checkbox"
										name="inScope"
										value={row.slug}
										checked={row.inScope}
										class="align-middle"
									/>
								</td>
								<td class="py-2 pr-2">
									<span>{row.name}</span>
									<span class="block font-mono text-xs text-zinc-500">{row.slug}</span>
								</td>
								<td class="py-2 pr-2">
									<input
										name="allow:{row.slug}"
										defaultValue={row.allow}
										placeholder="*"
										class="w-40 rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
									/>
								</td>
								<td class="py-2 pr-2">
									<input
										name="deny:{row.slug}"
										defaultValue={row.deny}
										placeholder="*delete*"
										class="w-40 rounded-md border border-zinc-300 bg-white px-2 py-1 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
									/>
								</td>
								<td class="py-2 text-xs tabular-nums">
									{#if !row.namesAvailable}
										<span
											class="text-zinc-400"
											title="No handshake has run yet, so the tool list is unknown.">unknown</span
										>
									{:else}
										{row.visible}/{row.toolsCount}
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<p class="text-xs text-zinc-500">
				Counts preview the rules currently saved. Save to apply; connected clients are told their
				tool list changed.
			</p>
			<Button submit>Save scope</Button>
		</form>
	</Card>

	<Card title="API keys using this profile">
		{#if data.blockedBy.length === 0}
			<p class="text-sm text-zinc-500">No active keys. This profile can be deleted safely.</p>
		{:else}
			<p class="text-sm text-zinc-500">
				Deletion is blocked while keys reference it — reassign or revoke
				{data.blockedBy.length} key{data.blockedBy.length === 1 ? '' : 's'} first:
			</p>
			<ul class="mt-1 flex flex-wrap gap-2 text-sm">
				{#each data.blockedBy as key (key.id)}
					<li>
						<a class="underline" href={resolve('/admin/keys/[id]', { id: key.id })}>{key.name}</a>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>

	<Card title="Danger zone">
		{#if confirmDelete}
			<form method="POST" action="?/remove" class="flex flex-wrap items-center gap-2" use:enhance>
				<p class="text-sm text-rose-700 dark:text-rose-300">
					Keys pointing here stop working immediately; their call history is kept.
				</p>
				{#if data.blockedBy.length > 0}
					<span class="text-sm text-amber-700 dark:text-amber-300"
						>Blocked until active keys are reassigned.</span
					>
				{:else}
					<Button submit variant="danger">Confirm delete</Button>
				{/if}
				<Button variant="ghost" onclick={() => (confirmDelete = false)}>Cancel</Button>
			</form>
		{:else}
			<Button variant="danger" onclick={() => (confirmDelete = true)}>Delete profile</Button>
		{/if}
	</Card>
</div>
