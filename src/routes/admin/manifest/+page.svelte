<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';

	let { data, form } = $props();
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">Manifest</h1>
			<p class="text-sm text-zinc-500">
				<code>gateway.yaml</code> is the reproducible definition of this gateway: check it into git and
				ship it from CI.
			</p>
		</div>
		<a
			class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
			href={resolve('/manifest')}
		>
			Download current
		</a>
	</div>

	{#if form?.errors}
		<div
			class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
			role="alert"
		>
			<p class="font-medium">Import rejected — nothing was written:</p>
			<ul class="mt-1 list-disc space-y-0.5 pl-5">
				{#each form.errors as issue (issue)}<li>{issue}</li>{/each}
			</ul>
		</div>
	{/if}

	{#if data.exportError}
		<div
			class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
			role="alert"
		>
			<p class="font-medium">Export refused — a value here looks like a real credential:</p>
			<p class="mt-1">{data.exportError}</p>
		</div>
	{/if}

	{#if form?.applied}
		<div
			class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
		>
			<p class="font-medium">Applied.</p>
			<ul class="mt-1 space-y-0.5">
				<li>added: {form.diff.added.join(', ') || '—'}</li>
				<li>updated: {form.diff.updated.join(', ') || '—'}</li>
				<li>disabled (removed from file): {form.diff.removed.join(', ') || '—'}</li>
				<li>profiles added: {form.diff.profilesAdded.join(', ') || '—'}</li>
			</ul>
			{#if form.unconfigured?.length}
				<p class="mt-2 font-medium text-amber-800 dark:text-amber-200">
					Cannot start until these host variables are set:
				</p>
				<ul class="list-disc pl-5">
					{#each form.unconfigured as item (item.slug)}
						<li><code>{item.slug}</code>: {item.missing.join(', ')}</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	{#if form?.diff && form.parsed}
		<Card title="Preview" description="What would change if you apply this file.">
			<dl class="grid gap-2 text-sm sm:grid-cols-2">
				<div>
					<dt class="text-zinc-500">Would add</dt>
					<dd>{form.diff.added.join(', ') || '—'}</dd>
				</div>
				<div>
					<dt class="text-zinc-500">Would update</dt>
					<dd>{form.diff.updated.join(', ') || '—'}</dd>
				</div>
				<div>
					<dt class="text-zinc-500">Would disable</dt>
					<dd>{form.diff.removed.join(', ') || '—'}</dd>
				</div>
				<div>
					<dt class="text-zinc-500">Unchanged</dt>
					<dd>{form.diff.unchanged.join(', ') || '—'}</dd>
				</div>
			</dl>
			<p class="mt-2 text-xs text-zinc-500">
				Upstreams missing from the file are disabled, not deleted — deleting would silently break
				anyone relying on them.
			</p>
		</Card>
	{/if}

	<div class="grid gap-4 lg:grid-cols-2">
		<Card title="Current configuration">
			<pre
				class="max-h-[32rem] overflow-auto rounded bg-zinc-100 p-3 text-xs dark:bg-zinc-800">{data.current}</pre>
		</Card>

		<Card
			title="Import"
			description="Secrets must be references: $&#123;ENV_VAR&#125; or secret:&lt;name&gt;. A literal token is rejected."
		>
			<form method="POST" action="?/preview" class="space-y-2" use:enhance>
				<textarea
					name="manifest"
					rows="18"
					spellcheck="false"
					class="w-full rounded-md border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
					placeholder={data.current}>{form?.text ?? ''}</textarea
				>
				<div class="flex flex-wrap gap-2">
					<Button submit variant="secondary">Preview changes</Button>
					{#if form?.parsed}
						<button
							type="submit"
							formaction="?/apply"
							class="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
						>
							Apply as previewed
						</button>
					{/if}
				</div>
			</form>
			<p class="mt-2 text-xs text-zinc-500">
				Applying is idempotent: re-applying the same file writes nothing.
			</p>
		</Card>
	</div>
</div>
