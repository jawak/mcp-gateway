<script lang="ts">
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import CopyButton from '$lib/ui/CopyButton.svelte';

	let { data, form } = $props();
	const saved = $derived(page.url.searchParams.get('saved') === '1');
</script>

<div class="space-y-4">
	<div>
		<h1 class="text-lg font-semibold">Settings</h1>
		<p class="text-sm text-zinc-500">
			Runtime tuning lives here. Anything that decides trust — master key, public URL, bind address,
			SSRF policy — comes from the environment and is read-only by design.
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

	<form method="POST" action="?/save" class="space-y-4" use:enhance>
		<Card
			title="Operational overrides"
			description="Stored on this instance; the worker and catalog pick them up within a cycle."
		>
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				{#each data.fields as { field, label } (field)}
					<label class="space-y-1 text-sm">
						<span class="text-zinc-500">{label}</span>
						<input
							name={field}
							type="number"
							min="1"
							value={String(data.effective[field])}
							class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
					</label>
				{/each}
			</div>

			<label class="flex items-start gap-2 text-sm">
				<input
					type="checkbox"
					name="debugPayload"
					checked={data.effective.debugPayload}
					class="mt-0.5"
				/>
				<span>
					Store redacted tool payloads for debugging.
					<span class="block text-xs text-zinc-500">
						Increases database growth; tokens are scrubbed, but assume anything a tool returns is
						written to disk.
					</span>
				</span>
			</label>

			<Button submit>Save settings</Button>
		</Card>
	</form>

	<Card title="Reset a single override" description="Falls back to the environment value.">
		<div class="flex flex-wrap gap-2">
			{#each data.overridable as field (field)}
				<form method="POST" action="?/reset" use:enhance>
					<input type="hidden" name="field" value={field} />
					<Button variant="ghost" submit>Reset {field}</Button>
				</form>
			{/each}
		</div>
	</Card>

	<Card
		title="Deployment (environment)"
		description="Change these in the process environment and restart."
	>
		<dl class="grid gap-2 text-sm sm:grid-cols-2">
			{#each data.immutable as item (item.label)}
				<div class="rounded border border-zinc-200 px-3 py-2 dark:border-zinc-800">
					<dt class="text-xs text-zinc-500">{item.label}</dt>
					<dd class="font-mono text-xs break-all">{item.value}</dd>
					<dd class="mt-0.5 text-xs text-zinc-400">{item.hint}</dd>
				</div>
			{/each}
		</dl>
		{#if data.effective.debugPayload}
			<p class="mt-2 text-xs text-amber-600">Payload debugging is on.</p>
		{/if}
	</Card>

	<Card
		title="Secrets"
		description="Values are sealed at rest and can never be read back through the dashboard."
	>
		{#if data.secrets.length === 0}
			<p class="text-sm text-zinc-500">None stored yet. Upstream forms can create them.</p>
		{:else}
			<ul class="space-y-1 text-sm">
				{#each data.secrets as secret (secret.name)}
					<li class="flex items-center justify-between gap-2">
						<span class="font-mono text-xs">secret:{secret.name}</span>
						<span class="text-xs text-zinc-500">
							created {new Date(secret.createdAt).toLocaleDateString()}
							{#if secret.rotatedAt}· rotated {new Date(secret.rotatedAt).toLocaleDateString()}{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>

	<Card title="Runtime state">
		<div class="flex flex-wrap items-center gap-3 text-sm">
			<pre
				class="flex-1 overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{JSON.stringify(
					data.healthz,
					null,
					2
				)}</pre>
			<CopyButton value={JSON.stringify(data.healthz, null, 2)} label="Copy status" />
		</div>
	</Card>
</div>
