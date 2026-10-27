<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';

	let { data, form } = $props();

	const connection = $derived(
		data.record.connection as {
			command?: string;
			args?: string[];
			cwd?: string;
			url?: string;
			authMode?: string;
			authStyle?: string;
			authName?: string;
			authRef?: string;
		}
	);
	const status = $derived(data.effectiveStatus);
	const oauthAuthorizationRequired = $derived(
		status === 'unconfigured' && data.authMode === 'oauth'
	);
	const checked = $derived(page.url.searchParams.get('checked') === '1');
	const saved = $derived(page.url.searchParams.get('saved') === '1');
	const queryError = $derived(page.url.searchParams.get('error'));

	let confirmDelete = $state(false);
	let copied = $state(false);

	const OAUTH_BADGE: Record<string, string> = {
		connected: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
		authorizing: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
		error: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
		disconnected: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
	};
	const OAUTH_STATUS_LABEL: Record<string, string> = {
		connected: 'Connected',
		authorizing: 'Authorizing',
		error: 'Error',
		disconnected: 'Disconnected'
	};

	function oauthStatusLabel(status: string): string {
		return OAUTH_STATUS_LABEL[status] ?? status;
	}

	function oauthBadgeClass(status: string): string {
		return OAUTH_BADGE[status] ?? OAUTH_BADGE.disconnected;
	}

	function relativeExpiry(iso: string): string {
		const target = new Date(iso).getTime();
		if (Number.isNaN(target)) return iso;
		const deltaMs = target - Date.now();
		const minutes = Math.round(Math.abs(deltaMs) / 60_000);
		const amount =
			minutes < 60
				? `${minutes} min`
				: minutes < 1_440
					? `${Math.round(minutes / 60)} h`
					: `${Math.round(minutes / 1_440)} d`;
		return deltaMs >= 0 ? `in ${amount}` : `${amount} ago`;
	}

	async function copyRedirectUri(uri: string): Promise<void> {
		if (typeof navigator === 'undefined' || !navigator.clipboard) return;
		try {
			await navigator.clipboard.writeText(uri);
			copied = true;
			setTimeout(() => (copied = false), 1_500);
		} catch {
			copied = false;
		}
	}
</script>

<div class="space-y-4">
	<nav class="text-sm text-zinc-500">
		<a class="underline" href={resolve('/admin/upstreams')}>Upstreams</a> /
		<span class="font-mono">{data.record.slug}</span>
	</nav>

	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">{data.record.name}</h1>
			<p class="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
				<Badge
					{status}
					label={oauthAuthorizationRequired ? 'Authorization required' : undefined}
					dot
				/>
				<span>{data.record.transport === 'stdio' ? 'local process' : 'remote HTTP'}</span>
				<span>·</span>
				<span>{data.record.toolsCount ?? 0} tools</span>
				<span>·</span>
				<span>{data.record.pin === 'pinned' ? 'kept warm' : 'started on demand'}</span>
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			<form method="POST" action="?/check" use:enhance>
				<Button submit variant="secondary">Check now</Button>
			</form>
			<form method="POST" action="?/toggle" use:enhance>
				<input type="hidden" name="enabled" value={String(!data.record.enabled)} />
				<Button submit variant={data.record.enabled ? 'danger' : 'primary'}>
					{data.record.enabled ? 'Disable' : 'Enable'}
				</Button>
			</form>
		</div>
	</div>

	{#if saved}
		<p
			class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
		>
			Saved.
		</p>
	{/if}
	{#if checked}
		<p
			class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
		>
			Probe finished — reload in a moment to see the new health state.
		</p>
	{/if}
	{#if queryError}
		<p
			class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
			role="alert"
		>
			Last probe failed: {queryError}
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

	{#if data.problems.length > 0}
		<div
			class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/40"
		>
			<h2 class="font-semibold text-amber-900 dark:text-amber-200">
				This upstream cannot start yet
			</h2>
			<ul class="mt-1 list-disc space-y-0.5 pl-5 text-amber-900 dark:text-amber-200">
				{#each data.problems as problem (problem)}<li>{problem}</li>{/each}
			</ul>
		</div>
	{/if}

	{#if oauthAuthorizationRequired}
		<div
			class="rounded-lg border border-sky-300 bg-sky-50 p-4 text-sm dark:border-sky-900 dark:bg-sky-950/40"
		>
			<h2 class="font-semibold text-sky-900 dark:text-sky-200">Authorization required</h2>
			<p class="mt-1 text-sky-900 dark:text-sky-200">
				This upstream authenticates with OAuth. Connect it to authorize access; until then the
				gateway will not contact it.
			</p>
		</div>
	{/if}

	{#if data.oauth}
		{@const redirectUri = data.oauth.redirectUri}
		<div id="oauth">
			<Card
				title="OAuth connection"
				description="This gateway connects with one shared identity for every caller."
			>
				<dl class="grid gap-2 text-sm sm:grid-cols-2">
					<div class="flex gap-2">
						<dt class="w-24 shrink-0 text-zinc-500">Status</dt>
						<dd>
							<span
								class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {oauthBadgeClass(
									data.oauth.status
								)}"
							>
								{oauthStatusLabel(data.oauth.status)}
							</span>
						</dd>
					</div>
					{#if data.oauth.scopes}
						<div class="flex gap-2">
							<dt class="w-24 shrink-0 text-zinc-500">Scope</dt>
							<dd class="font-mono">{data.oauth.scopes}</dd>
						</div>
					{/if}
					{#if data.oauth.clientId}
						<div class="flex gap-2">
							<dt class="w-24 shrink-0 text-zinc-500">Client ID</dt>
							<dd class="font-mono break-all">{data.oauth.clientId}</dd>
						</div>
					{/if}
					{#if data.oauth.expiresAt}
						<div class="flex gap-2 sm:col-span-2">
							<dt class="w-24 shrink-0 text-zinc-500">Expires</dt>
							<dd>
								<span class="font-medium">{relativeExpiry(data.oauth.expiresAt)}</span>
								<span class="text-zinc-500"
									>· {new Date(data.oauth.expiresAt).toLocaleString()}</span
								>
							</dd>
						</div>
					{/if}
					{#if data.oauth.connectedAt}
						<div class="flex gap-2">
							<dt class="w-24 shrink-0 text-zinc-500">Connected</dt>
							<dd>{new Date(data.oauth.connectedAt).toLocaleString()}</dd>
						</div>
					{/if}
					{#if data.oauth.connectedBy}
						<div class="flex gap-2">
							<dt class="w-24 shrink-0 text-zinc-500">Connected by</dt>
							<dd class="break-all">{data.oauth.connectedBy}</dd>
						</div>
					{/if}
				</dl>

				{#if data.oauth.lastError}
					<p
						class="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200"
						role="alert"
					>
						Last error: {data.oauth.lastError}
					</p>
				{/if}

				<div class="mt-4 space-y-2">
					<p class="text-xs text-zinc-500">
						Allowlist this exact redirect URI in the authorization server before connecting.
					</p>
					<div class="flex flex-wrap items-center gap-2">
						<code
							class="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-xs break-all dark:border-zinc-800 dark:bg-zinc-950"
							>{redirectUri}</code
						>
						<Button variant="secondary" onclick={() => copyRedirectUri(redirectUri)}>
							{copied ? 'Copied' : 'Copy'}
						</Button>
					</div>
				</div>

				{#if data.oauth.canManage}
					<div class="mt-4 flex flex-wrap gap-2">
						<form method="POST" action="?/oauthStart" use:enhance>
							<Button submit variant={data.oauth.status === 'connected' ? 'secondary' : 'primary'}>
								{data.oauth.status === 'connected' ? 'Reconnect' : 'Connect'}
							</Button>
						</form>
						{#if data.oauth.status === 'connected'}
							<form method="POST" action="?/oauthDisconnect" use:enhance>
								<Button submit variant="danger">Disconnect</Button>
							</form>
						{/if}
					</div>
				{/if}
			</Card>
		</div>
	{/if}

	<div class="grid gap-4 lg:grid-cols-2">
		<div>
			<Card title="Connection">
				{#if data.record.transport === 'stdio'}
					<dl class="space-y-1 text-sm">
						<div class="flex gap-2">
							<dt class="w-24 text-zinc-500">Command</dt>
							<dd class="font-mono">{connection.command}</dd>
						</div>
						<div class="flex gap-2">
							<dt class="w-24 shrink-0 text-zinc-500">Arguments</dt>
							<dd class="font-mono break-all">{(connection.args ?? []).join(' ') || '—'}</dd>
						</div>
						{#if connection.cwd}
							<div class="flex gap-2">
								<dt class="w-24 text-zinc-500">cwd</dt>
								<dd class="font-mono break-all">{connection.cwd}</dd>
							</div>
						{/if}
					</dl>
				{:else}
					<dl class="space-y-1 text-sm">
						<div class="flex gap-2">
							<dt class="w-24 text-zinc-500">URL</dt>
							<dd class="font-mono break-all">{connection.url}</dd>
						</div>
						<div class="flex gap-2">
							<dt class="w-24 text-zinc-500">Auth</dt>
							<dd class="font-mono">{connection.authStyle ?? 'none'}</dd>
						</div>
						{#if connection.authName}
							<div class="flex gap-2">
								<dt class="w-24 text-zinc-500">Header</dt>
								<dd class="font-mono">{connection.authName}</dd>
							</div>
						{/if}
						{#if connection.authRef}
							<div class="flex gap-2">
								<dt class="w-24 text-zinc-500">Credential</dt>
								<dd class="font-mono break-all">{connection.authRef}</dd>
							</div>
						{/if}
					</dl>
				{/if}
				<p class="mt-3 text-xs text-zinc-500">
					Env references are resolved at spawn time; the gateway's own secrets are never passed to
					the child process.
				</p>
			</Card>
		</div>

		<Card title="Handshake" description="Reported by the upstream at its last probe">
			{#if data.record.status?.server}
				<dl class="space-y-1 text-sm">
					<div class="flex gap-2">
						<dt class="w-24 text-zinc-500">Server</dt>
						<dd>
							{data.record.status.server.name}
							{data.record.status.server.version ?? ''}
						</dd>
					</div>
					<div class="flex gap-2">
						<dt class="w-24 text-zinc-500">Tools</dt>
						<dd>{data.record.toolsCount ?? 0}</dd>
					</div>
					{#if data.record.status.checkedAt}
						<div class="flex gap-2">
							<dt class="w-24 text-zinc-500">Probed</dt>
							<dd>{new Date(data.record.status.checkedAt).toLocaleString()}</dd>
						</div>
					{/if}
					<div class="flex gap-2">
						<dt class="w-24 shrink-0 text-zinc-500">Capabilities</dt>
						<dd class="font-mono text-xs">
							{Object.keys((data.record.caps ?? {}) as object).join(', ') || '—'}
						</dd>
					</div>
				</dl>
			{:else}
				<p class="text-sm text-zinc-500">Never contacted. Run “Check now” to probe it.</p>
			{/if}
		</Card>
	</div>

	<Card title="Visibility" description="Profiles that expose this upstream">
		{#if data.scopes.length === 0}
			<p class="text-sm text-zinc-500">
				Not in any profile, so no API key can reach it.
				<a class="underline" href={resolve('/admin/profiles')}>Add it to a profile</a>.
			</p>
		{:else}
			<ul class="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
				{#each data.scopes as scope (scope.id)}
					<li class="flex flex-wrap items-center justify-between gap-2 py-2">
						<a class="underline" href={resolve('/admin/profiles/[id]', { id: scope.id })}
							>{scope.name}</a
						>
						<span class="font-mono text-xs text-zinc-500">
							allow: {scope.allow.join(' ')}{#if scope.deny.length}
								· deny: {scope.deny.join(' ')}{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>

	<Card
		title="Edit"
		description="Values referencing secrets stay references; nothing here reveals a stored value."
	>
		<form method="POST" action="?/update" class="space-y-3" use:enhance>
			<div class="grid gap-3 sm:grid-cols-2">
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Display name</span>
					<input
						name="name"
						value={form?.values?.name ?? data.record.name}
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Warmth</span>
					<select
						name="pin"
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						<option value="pinned" selected={data.record.pin === 'pinned'}>pinned</option>
						<option value="lazy" selected={data.record.pin === 'lazy'}>lazy</option>
					</select>
				</label>
				{#if data.record.transport === 'stdio'}
					<label class="space-y-1 text-sm">
						<span class="text-zinc-500">Command</span>
						<input
							name="command"
							value={form?.values?.command ?? connection.command ?? ''}
							class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
					</label>
					<label class="space-y-1 text-sm">
						<span class="text-zinc-500">Arguments</span>
						<input
							name="args"
							value={form?.values?.args ?? (connection.args ?? []).join(' ')}
							class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
					</label>
				{:else}
					<label class="space-y-1 text-sm sm:col-span-2">
						<span class="text-zinc-500">URL</span>
						<input
							name="url"
							value={form?.values?.url ?? connection.url ?? ''}
							class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
						/>
					</label>
				{/if}
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Call timeout (ms)</span>
					<input
						name="timeoutMs"
						type="number"
						min="1000"
						max="600000"
						step="1000"
						value={form?.values?.timeoutMs ?? String(data.record.timeoutMs)}
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
			</div>

			<label class="block space-y-1 text-sm">
				<span class="text-zinc-500">Environment references</span>
				<textarea
					name="env"
					rows="4"
					class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>{form?.values?.env ??
						Object.entries(data.record.envRefs ?? {})
							.map(([name, ref]) => `${name}=${ref}`)
							.join('\n')}</textarea
				>
				{#if form?.fieldErrors?.env}<span class="text-xs text-rose-600">{form.fieldErrors.env}</span
					>{/if}
			</label>

			<div class="grid gap-3 sm:grid-cols-2">
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Rotate a secret (name)</span>
					<input
						name="secretName"
						list="secret-names"
						value={form?.values?.secretName ?? ''}
						placeholder="github__github_token"
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
					<datalist id="secret-names">
						{#each data.secrets as secret (secret.name)}<option value={secret.name}></option>{/each}
					</datalist>
				</label>
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">New value (never shown again)</span>
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
			</div>

			<div class="flex gap-2">
				<Button submit>Save and re-probe</Button>
				<span class="self-center text-xs text-zinc-500"
					>Renaming tools or slugs is not offered: tool names are part of the contract clients rely
					on.</span
				>
			</div>
		</form>
	</Card>

	{#if data.history.length > 0}
		<Card title="Health history" description="Newest first">
			<table class="w-full text-sm">
				<thead class="text-left text-xs tracking-wide text-zinc-500 uppercase">
					<tr
						><th class="pb-1 font-medium">When</th><th class="pb-1 font-medium">State</th><th
							class="pb-1 font-medium">Latency</th
						><th class="pb-1 font-medium">Error</th></tr
					>
				</thead>
				<tbody class="divide-y divide-zinc-100 dark:divide-zinc-800">
					{#each data.history as row (row.checkedAt)}
						<tr>
							<td class="py-1.5 pr-2 text-xs text-zinc-500"
								>{new Date(row.checkedAt).toLocaleString()}</td
							>
							<td class="py-1.5 pr-2"><Badge status={row.status} /></td>
							<td class="py-1.5 pr-2 text-xs tabular-nums">{row.latencyMs ?? '—'}</td>
							<td class="max-w-md truncate py-1.5 text-xs text-zinc-500" title={row.error ?? ''}
								>{row.error ?? ''}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</Card>
	{/if}

	<Card title="Danger zone">
		{#if confirmDelete}
			<form method="POST" action="?/remove" class="flex flex-wrap items-center gap-2" use:enhance>
				<p class="text-sm text-rose-700 dark:text-rose-300">
					Delete removes the upstream and hides its tools from every profile. Existing call history
					is kept.
				</p>
				<Button submit variant="danger">Confirm delete</Button>
				<Button variant="ghost" onclick={() => (confirmDelete = false)}>Cancel</Button>
			</form>
		{:else}
			<Button variant="danger" onclick={() => (confirmDelete = true)}>Delete upstream</Button>
		{/if}
	</Card>
</div>
