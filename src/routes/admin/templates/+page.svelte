<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';

	let { data, form } = $props();

	// a failed submit reopens the panel the operator was filling in, so the effective
	// value is derived from the form rather than captured once at init
	let manualOpen = $state('');
	let dismissed = $state('');
	const openId = $derived(form?.openId && form.openId !== dismissed ? form.openId : manualOpen);

	function open(id: string) {
		manualOpen = id;
		dismissed = '';
	}

	function close() {
		manualOpen = '';
		dismissed = form?.openId ?? '';
	}
</script>

<div class="space-y-4">
	<div>
		<h1 class="text-lg font-semibold">Templates</h1>
		<p class="text-sm text-zinc-500">
			Known-good configurations for popular MCP servers. Nothing is downloaded or executed on
			install; credentials become sealed secrets referenced by the upstream.
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

	<div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
		{#each data.templates as template (template.id)}
			<Card title={template.name} description={template.description}>
				<div class="space-y-3">
					<p class="flex flex-wrap items-center gap-1 text-xs text-zinc-500">
						<span class="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800"
							>{template.transport === 'stdio' ? 'local process' : 'remote'}</span
						>
						{#each template.tags as tag (tag)}
							<span class="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{tag}</span>
						{/each}
					</p>

					{#if openId === template.id}
						<form method="POST" action="?/install" class="space-y-2" use:enhance>
							<input type="hidden" name="template" value={template.id} />
							<label class="block space-y-1 text-sm">
								<span class="text-zinc-500">Slug</span>
								<input
									name="slug"
									value={form?.slug ?? template.id}
									class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
								/>
							</label>
							{#each template.fields as field (field.env)}
								<label class="block space-y-1 text-sm">
									<span class="text-zinc-500">
										{field.label}
										{#if !field.required}<span class="text-xs">(optional)</span>{/if}
									</span>
									<input
										name="field:{field.env}"
										type={field.secret ? 'password' : 'text'}
										autocomplete={field.secret ? 'new-password' : 'off'}
										value={form?.answers?.[field.env] ?? ''}
										required={field.required}
										class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
									/>
									<span class="text-xs text-zinc-400">{field.help}</span>
								</label>
							{/each}
							<div class="flex gap-2">
								<Button submit>Install and test</Button>
								<Button variant="ghost" onclick={close}>Cancel</Button>
							</div>
							{#if template.docsUrl}
								<a
									class="block text-xs underline"
									href={template.docsUrl}
									rel="noopener noreferrer"
									target="_blank"
								>
									Upstream documentation
								</a>
							{/if}
						</form>
					{:else}
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs text-zinc-500">
								{template.fields.length === 0
									? 'No credentials needed'
									: `${template.fields.length} value${template.fields.length === 1 ? '' : 's'} required`}
							</span>
							<Button variant="secondary" onclick={() => open(template.id)}>Install</Button>
						</div>
					{/if}
				</div>
			</Card>
		{/each}
	</div>

	<p class="text-xs text-zinc-500">
		Commands assume <code>npx</code> / <code>uvx</code> are available on the gateway host. Missing
		runtime shows up as a failed probe with the real error, and the upstream is left disabled until
		you fix it.
		<a class="underline" href={resolve('/admin/upstreams/new')}>Or configure by hand</a>.
	</p>
</div>
