<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';

	let { data, form } = $props();
</script>

<div class="space-y-4">
	<div>
		<h1 class="text-lg font-semibold">Profiles</h1>
		<p class="text-sm text-zinc-500">
			A profile is the set of upstreams and tools an API key may reach. Fewer, well-chosen tools
			also mean better tool selection by the model.
		</p>
	</div>

	{#if form?.error}
		<p
			class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
			role="alert"
		>
			{form.error}
		</p>
	{/if}

	{#if data.profiles.length === 0}
		<EmptyState title="No profiles yet" hint="Create one, then issue an API key against it." />
	{:else}
		<div class="grid gap-4 md:grid-cols-2">
			{#each data.profiles as profile (profile.id)}
				<Card title={profile.name}>
					<dl class="space-y-1 text-sm">
						<div class="flex justify-between">
							<dt class="text-zinc-500">Upstreams</dt>
							<dd>{profile.upstreams.length}</dd>
						</div>
						<div class="flex justify-between">
							<dt class="text-zinc-500">Tools (approx.)</dt>
							<dd>{profile.visibleTools}</dd>
						</div>
						<div class="flex justify-between">
							<dt class="text-zinc-500">Rate limit</dt>
							<dd>{profile.rateLimitRpm}/min</dd>
						</div>
						<div class="flex justify-between">
							<dt class="text-zinc-500">Daily quota</dt>
							<dd>{profile.dailyCallQuota || 'unlimited'}</dd>
						</div>
					</dl>
					<p class="mt-2 truncate font-mono text-xs text-zinc-500">
						{profile.upstreams.join(', ')}
					</p>
					<div class="mt-3">
						<Button href={resolve('/admin/profiles/[id]', { id: profile.id })} variant="secondary"
							>Manage</Button
						>
					</div>
				</Card>
			{/each}
		</div>
	{/if}

	<Card title="New profile">
		<form method="POST" action="?/create" class="space-y-3" use:enhance>
			<div class="grid gap-3 sm:grid-cols-4">
				<label class="space-y-1 text-sm sm:col-span-2">
					<span class="text-zinc-500">Name</span>
					<input
						name="name"
						required
						placeholder="team-platform"
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Requests / min</span>
					<input
						name="rateLimitRpm"
						type="number"
						min="1"
						value="120"
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Calls / day</span>
					<input
						name="dailyCallQuota"
						type="number"
						min="0"
						value="1000"
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
			</div>

			<fieldset class="space-y-1">
				<legend class="text-sm text-zinc-500">Upstreams in scope</legend>
				{#if data.upstreams.length === 0}
					<p class="text-sm text-zinc-500">
						No upstreams configured. <a class="underline" href={resolve('/admin/upstreams/new')}
							>Add one first</a
						>.
					</p>
				{:else}
					<div class="grid gap-1 sm:grid-cols-2">
						{#each data.upstreams as upstream (upstream.slug)}
							<label class="flex items-center gap-2 text-sm">
								<input type="checkbox" name="upstream" value={upstream.slug} />
								<span>{upstream.name}</span>
								<span class="font-mono text-xs text-zinc-500">{upstream.toolsCount}</span>
							</label>
						{/each}
					</div>
				{/if}
			</fieldset>

			<Button submit>Create profile</Button>
		</form>
	</Card>
</div>
