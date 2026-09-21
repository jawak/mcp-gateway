<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';

	let { form, data } = $props();

	// Default comes from the server-rendered `checked` attribute below, so the
	// radio group is correct after a failed submit without reading `form` at
	// $state init time (which would freeze the initial value).
	let transport = $state<'stdio' | 'http'>('stdio');
</script>

<div class="max-w-3xl space-y-4">
	<div>
		<h1 class="text-lg font-semibold">Add upstream</h1>
		<p class="text-sm text-zinc-500">
			Spawned by the gateway, reached by every client through one URL. Nothing is installed on your
			laptop.
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

	<Card
		title="Install from a template"
		description="Fills in the known-good command and asks only for credentials."
	>
		<form method="POST" action="?/fromTemplate" class="flex flex-wrap items-end gap-2" use:enhance>
			<label class="min-w-48 flex-1 space-y-1 text-sm">
				<span class="text-zinc-500">Template</span>
				<select
					name="template"
					class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
				>
					{#each data.templates as template (template.id)}
						<option value={template.id}>{template.name}</option>
					{/each}
				</select>
			</label>
			<label class="min-w-36 flex-1 space-y-1 text-sm">
				<span class="text-zinc-500">Slug (optional)</span>
				<input
					name="slug"
					placeholder="defaults to the template id"
					class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
				/>
			</label>
			<Button>Install</Button>
			<a class="self-center text-sm underline" href={resolve('/admin/templates')}
				>Browse all templates</a
			>
		</form>
		<p class="mt-2 text-xs text-zinc-500">
			Credentials you enter here are sealed on this server and referenced as <code
				>secret:&lt;name&gt;</code
			>; the exported manifest never contains them.
		</p>
	</Card>

	<Card title="Or configure by hand">
		<form method="POST" action="?/create" class="space-y-4" use:enhance>
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Slug</span>
					<input
						name="slug"
						required
						value={form?.values?.slug ?? ''}
						placeholder="github"
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
					{#if form?.fieldErrors?.slug}<span class="text-xs text-rose-600"
							>{form.fieldErrors.slug}</span
						>{/if}
				</label>
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Display name</span>
					<input
						name="name"
						required
						value={form?.values?.name ?? ''}
						placeholder="GitHub"
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
					{#if form?.fieldErrors?.name}<span class="text-xs text-rose-600"
							>{form.fieldErrors.name}</span
						>{/if}
				</label>
			</div>

			<fieldset class="space-y-3">
				<legend class="text-sm text-zinc-500">Transport</legend>
				<div class="flex gap-4 text-sm">
					<label class="flex items-center gap-2">
						<input
							type="radio"
							name="transport"
							value="stdio"
							bind:group={transport}
							checked={transport === 'stdio'}
						/>
						Local process (stdio)
					</label>
					<label class="flex items-center gap-2">
						<input
							type="radio"
							name="transport"
							value="http"
							bind:group={transport}
							checked={transport === 'http'}
						/>
						Remote (Streamable HTTP)
					</label>
				</div>

				{#if transport === 'stdio'}
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="space-y-1 text-sm">
							<span class="text-zinc-500">Command</span>
							<input
								name="command"
								value={form?.values?.command ?? 'npx'}
								placeholder="npx"
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
							/>
							{#if form?.fieldErrors?.command}<span class="text-xs text-rose-600"
									>{form.fieldErrors.command}</span
								>{/if}
						</label>
						<label class="space-y-1 text-sm">
							<span class="text-zinc-500">Arguments (space separated)</span>
							<input
								name="args"
								value={form?.values?.args ?? ''}
								placeholder="-y @modelcontextprotocol/server-github"
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
							/>
						</label>
						<label class="space-y-1 text-sm sm:col-span-2">
							<span class="text-zinc-500">Working directory (optional)</span>
							<input
								name="cwd"
								value={form?.values?.cwd ?? ''}
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
							/>
						</label>
					</div>
				{:else}
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="space-y-1 text-sm sm:col-span-2">
							<span class="text-zinc-500">URL</span>
							<input
								name="url"
								value={form?.values?.url ?? ''}
								placeholder="https://mcp.sentry.dev/mcp"
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
							/>
							{#if form?.fieldErrors?.url}<span class="text-xs text-rose-600"
									>{form.fieldErrors.url}</span
								>{/if}
						</label>
						<label class="space-y-1 text-sm">
							<span class="text-zinc-500">Auth style</span>
							<select
								name="authStyle"
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
							>
								<option value="none">none</option>
								<option value="bearer">bearer</option>
								<option value="header">custom header</option>
							</select>
						</label>
						<label class="space-y-1 text-sm">
							<span class="text-zinc-500">Header name (custom header only)</span>
							<input
								name="authName"
								value={form?.values?.authName ?? 'authorization'}
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
							/>
						</label>
						<label class="space-y-1 text-sm sm:col-span-2">
							<span class="text-zinc-500">Credential reference</span>
							<input
								name="authRef"
								value={form?.values?.authRef ?? ''}
								placeholder="secret:sentry-token"
								class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
							/>
							{#if form?.fieldErrors?.authRef}<span class="text-xs text-rose-600"
									>{form.fieldErrors.authRef}</span
								>{/if}
						</label>
					</div>
				{/if}
			</fieldset>

			<div class="grid gap-3">
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">
						Environment (one <code>NAME=value</code> per line; <code>$&#123;VAR&#125;</code>,
						<code>secret:&lt;name&gt;</code>, or a literal)
					</span>
					<textarea
						name="env"
						rows="4"
						value={form?.values?.env ?? ''}
						placeholder={'GITHUB_TOKEN=${GITHUB_TOKEN}\nLOG_LEVEL=debug'}
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
					></textarea>
					{#if form?.fieldErrors?.env}<span class="text-xs text-rose-600"
							>{form.fieldErrors.env}</span
						>{/if}
					<span class="text-xs text-zinc-500">
						Anything that looks like a token is refused here on purpose — seal it below and
						reference it.
					</span>
				</label>

				<div class="grid gap-3 sm:grid-cols-2">
					<label class="space-y-1 text-sm">
						<span class="text-zinc-500">New secret name (optional)</span>
						<input
							name="secretName"
							value={form?.values?.secretName ?? ''}
							placeholder="github-token"
							class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
						{#if form?.fieldErrors?.secretName}<span class="text-xs text-rose-600"
								>{form.fieldErrors.secretName}</span
							>{/if}
					</label>
					<label class="space-y-1 text-sm">
						<span class="text-zinc-500">Secret value (never displayed again)</span>
						<input
							name="secretValue"
							type="password"
							autocomplete="new-password"
							class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
						{#if form?.fieldErrors?.secretValue}<span class="text-xs text-rose-600"
								>{form.fieldErrors.secretValue}</span
							>{/if}
					</label>
					<label class="space-y-1 text-sm">
						<span class="text-zinc-500">Warmth</span>
						<select
							name="pin"
							class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						>
							<option value="pinned">pinned — kept running</option>
							<option value="lazy">lazy — started on demand</option>
						</select>
					</label>
					<label class="space-y-1 text-sm">
						<span class="text-zinc-500">Call timeout (ms)</span>
						<input
							name="timeoutMs"
							type="number"
							min="1000"
							max="600000"
							step="1000"
							value={form?.values?.timeoutMs ?? '60000'}
							class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
					</label>
				</div>
			</div>

			<p class="text-xs text-zinc-500">
				{data.secrets.length} secret{data.secrets.length === 1 ? '' : 's'} already sealed on this server
				— reference them as
				<code>secret:&lt;name&gt;</code>.
			</p>

			<div class="flex gap-2">
				<Button submit>Create and test</Button>
				<Button href={resolve('/admin/upstreams')} variant="ghost">Cancel</Button>
			</div>
		</form>
	</Card>
</div>
