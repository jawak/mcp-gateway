<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import ClientSnippet from '$lib/ui/ClientSnippet.svelte';

	let { data, form } = $props();

	let created = $derived(form?.created);
</script>

<div class="max-w-3xl space-y-4">
	<nav class="text-sm text-zinc-500">
		<a class="underline" href={resolve('/admin/keys')}>API keys</a> / new
	</nav>

	{#if created}
		<Card
			title="Copy this key now"
			description="It is stored only as a hash; this page is the last time it can be shown. Closing it means rotating the key."
		>
			<div class="space-y-3">
				<div class="flex items-center gap-2">
					<code
						class="flex-1 rounded bg-zinc-100 px-3 py-2 font-mono text-xs break-all dark:bg-zinc-800"
						>{created.plaintext}</code
					>
					<button
						type="button"
						onclick={() => navigator.clipboard.writeText(created.plaintext)}
						class="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
					>
						Copy
					</button>
				</div>
				<ClientSnippet endpoint={form?.endpoint ?? '/mcp'} key={created.plaintext} />
			</div>
		</Card>
		<p class="text-xs text-zinc-500">
			Go to the <a class="underline" href={resolve('/admin/keys/[id]', { id: created.id })}
				>key page</a
			>
			for rotation, suspension and usage.
		</p>
	{:else}
		<div>
			<h1 class="text-lg font-semibold">New API key</h1>
			<p class="text-sm text-zinc-500">
				A key is a long-lived bearer credential: treat it like a password.
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
			<p
				class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
			>
				Create a <a class="underline" href={resolve('/admin/profiles')}>profile</a> first — a key without
				a scope would reach nothing.
			</p>
		{:else}
			<Card>
				<form method="POST" class="space-y-3" use:enhance>
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="space-y-1 text-sm">
							<span class="text-zinc-500">Name</span>
							<input
								name="name"
								required
								placeholder="arya-macbook"
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
							/>
						</label>
						<label class="space-y-1 text-sm">
							<span class="text-zinc-500">Profile</span>
							<select
								name="profileId"
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
							>
								{#each data.profiles as profile (profile.id)}
									<option value={profile.id}>{profile.name} ({profile.rateLimitRpm}/min)</option>
								{/each}
							</select>
						</label>
						<label class="space-y-1 text-sm">
							<span class="text-zinc-500">Valid for (days)</span>
							<input
								name="validityDays"
								type="number"
								min="1"
								max="3650"
								value="90"
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
							/>
						</label>
						<label class="space-y-1 text-sm">
							<span class="text-zinc-500">IP allowlist (optional)</span>
							<input
								name="ipAllowlist"
								placeholder="203.0.113.7, 10.20.0.0/16"
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
							/>
						</label>
					</div>

					<label class="flex items-start gap-2 text-sm">
						<input type="checkbox" name="allowAnyIp" class="mt-0.5" />
						<span>
							Allow any address. Leave unchecked to keep the key usable only from the addresses
							above — recommended for keys that can write to real systems.
						</span>
					</label>

					<Button submit>Create key</Button>
				</form>
			</Card>
		{/if}
	{/if}
</div>
