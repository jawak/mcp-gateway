<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import ClientSnippet from '$lib/ui/ClientSnippet.svelte';

	let { data, form } = $props();
	const rotated = $derived(form?.rotated);
	const saved = $derived(page.url.searchParams.get('saved') === '1');
	let confirmRevoke = $state(false);
</script>

<div class="space-y-4">
	<nav class="text-sm text-zinc-500">
		<a class="underline" href={resolve('/admin/keys')}>API keys</a> / {data.key.name}
	</nav>

	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">{data.key.name}</h1>
			<p class="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
				<Badge
					status={data.key.status === 'active' && !data.expired
						? 'healthy'
						: data.key.status === 'suspended'
							? 'degraded'
							: 'down'}
					label={data.expired && data.key.status === 'active' ? 'Expired' : data.key.status}
				/>
				<span class="font-mono">{data.key.keyPrefix}…{data.key.keyTail4}</span>
			</p>
		</div>
		<form method="POST" action="?/rotate" use:enhance>
			<Button submit variant="secondary">Rotate</Button>
		</form>
	</div>

	{#if rotated}
		<Card
			title="New key value"
			description="The old value stopped working the moment you rotated. Copy this now."
		>
			<div class="space-y-3">
				<code
					class="block rounded bg-zinc-100 px-3 py-2 font-mono text-xs break-all dark:bg-zinc-800"
					>{rotated.plaintext}</code
				>
				<ClientSnippet endpoint={`${page.url.origin}/mcp`} key={rotated.plaintext} />
			</div>
		</Card>
	{/if}
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

	<div class="grid gap-4 lg:grid-cols-2">
		<Card title="Scope">
			<dl class="space-y-1 text-sm">
				<div class="flex justify-between">
					<dt class="text-zinc-500">Profile</dt>
					<dd>
						{#if data.profileOk}
							<a
								class="underline"
								href={resolve('/admin/profiles/[id]', { id: data.key.profileId })}
								>{data.profileName}</a
							>
						{:else}
							<span class="text-amber-600">{data.profileName}</span>
						{/if}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-zinc-500">Created</dt>
					<dd>{new Date(data.key.createdAt).toLocaleString()}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-zinc-500">Expires</dt>
					<dd>
						{data.key.expiresAt ? new Date(data.key.expiresAt).toLocaleDateString() : 'never'}
					</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-zinc-500">Last used</dt>
					<dd>{data.key.lastUsedAt ? new Date(data.key.lastUsedAt).toLocaleString() : 'never'}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-zinc-500">Calls (24h)</dt>
					<dd>{data.usage.calls} · {data.usage.errors} errors</dd>
				</div>
			</dl>
		</Card>

		<Card title="Source addresses">
			<form method="POST" action="?/allowlist" class="space-y-2" use:enhance>
				<input
					name="ipAllowlist"
					defaultValue={(data.key.ipAllowlist ?? []).join(', ')}
					placeholder="empty = any address"
					class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
				/>
				<p class="text-xs text-zinc-500">
					Exact addresses, <code>10.0.0.</code> prefixes or CIDR ranges.
				</p>
				<Button submit variant="secondary">Save</Button>
			</form>
		</Card>
	</div>

	<Card title="Status">
		<form method="POST" action="?/suspend" class="flex flex-wrap gap-2" use:enhance>
			{#if data.key.status === 'suspended'}
				<input type="hidden" name="resume" value="true" />
				<Button submit>Resume</Button>
			{:else if data.key.status === 'active'}
				<input type="hidden" name="resume" value="false" />
				<Button submit variant="secondary">Suspend (reversible)</Button>
			{:else}
				<p class="text-sm text-zinc-500">
					This key is revoked and cannot be brought back — create a new one instead.
				</p>
			{/if}
		</form>
	</Card>

	<Card title="Danger zone">
		{#if confirmRevoke}
			<form method="POST" action="?/revoke" class="flex flex-wrap items-center gap-2" use:enhance>
				<p class="text-sm text-rose-700 dark:text-rose-300">
					Every live session using this key is closed within seconds. This cannot be undone.
				</p>
				<Button submit variant="danger">Confirm revoke</Button>
				<Button variant="ghost" onclick={() => (confirmRevoke = false)}>Cancel</Button>
			</form>
		{:else if data.key.status !== 'revoked'}
			<Button variant="danger" onclick={() => (confirmRevoke = true)}>Revoke key</Button>
		{/if}
	</Card>
</div>
