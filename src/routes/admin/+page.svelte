<script lang="ts">
	import { resolve } from '$app/paths';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';
	import EmptyState from '$lib/ui/EmptyState.svelte';

	let { data } = $props();

	const steps = $derived([
		{
			done: data.hasUpstream,
			label: 'Add an upstream MCP server',
			href: '/admin/upstreams/new' as const
		},
		{
			done: data.hasProfile,
			label: 'Create a profile (who may use what)',
			href: '/admin/profiles'
		},
		{ done: data.hasKey, label: 'Issue an API key', href: '/admin/keys/new' as const }
	]);
	const nextStep = $derived(steps.find((step) => !step.done));
</script>

<div class="space-y-6">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">Dashboard</h1>
			<p class="text-sm text-zinc-500">
				One endpoint, {data.upstreamCount} upstream{data.upstreamCount === 1 ? '' : 's'}.
			</p>
		</div>
		<div class="flex gap-2">
			<Button href={resolve('/admin/upstreams/new')} variant="secondary">Add upstream</Button>
			<Button href={resolve('/admin/keys/new')} variant="primary">New API key</Button>
		</div>
	</div>

	{#if data.down.length > 0}
		<div
			class="rounded-lg border border-rose-300 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950/40"
		>
			<h2 class="text-sm font-semibold text-rose-900 dark:text-rose-200">
				{data.down.length} upstream{data.down.length === 1 ? '' : 's'} need attention
			</h2>
			<ul class="mt-2 space-y-1 text-sm">
				{#each data.down as item (item.slug)}
					<li class="flex flex-wrap items-center gap-2">
						<a class="underline" href={resolve('/admin/upstreams/[slug]', { slug: item.slug })}
							>{item.name}</a
						>
						<Badge status={item.status} />
						{#if item.error}<span class="truncate text-xs text-rose-700 dark:text-rose-300"
								>{item.error}</span
							>{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if nextStep}
		<EmptyState
			title="Finish setting up: {nextStep.label}"
			hint="Three steps and any MCP client can reach every upstream through one URL."
		>
			{#snippet action()}
				<Button href={nextStep.href}>Continue</Button>
			{/snippet}
		</EmptyState>
	{/if}

	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
		<Card title="Calls (24h)">{data.stats.calls24h.toLocaleString()}</Card>
		<Card title="Error rate (24h)">
			{(data.stats.errorRate * 100).toFixed(1)}%
			<span class="text-xs text-zinc-500">({data.stats.errors24h} calls)</span>
		</Card>
		<Card title="Latency p50 / p95">
			{data.stats.p50Ms} ms <span class="text-zinc-400">/</span>
			{data.stats.p95Ms} ms
		</Card>
		<Card title="Active keys">{data.activeKeyCount}</Card>
	</div>

	<div class="grid gap-4 lg:grid-cols-2">
		<Card title="Upstream health" description="Newest probe result per upstream">
			{#if data.rows.length === 0}
				<p class="text-sm text-zinc-500">Nothing configured yet.</p>
			{:else}
				<ul class="divide-y divide-zinc-100 dark:divide-zinc-800">
					{#each data.rows as row (row.slug)}
						<li class="flex items-center justify-between gap-3 py-2 text-sm">
							<a
								class="truncate underline-offset-2 hover:underline"
								href={resolve('/admin/upstreams/[slug]', { slug: row.slug })}>{row.name}</a
							>
							<span class="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
								{row.toolsCount} tools
								{#if row.latencyMs !== null}<span>{row.latencyMs} ms</span>{/if}
								<Badge status={row.status} dot />
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Card>

		<Card title="Most used tools (24h)">
			{#if data.top.length === 0}
				<p class="text-sm text-zinc-500">
					No calls recorded yet. Connect a client to start seeing usage.
				</p>
			{:else}
				<table class="w-full text-sm">
					<tbody class="divide-y divide-zinc-100 dark:divide-zinc-800">
						{#each data.top as tool (tool.tool)}
							<tr>
								<td class="py-1.5 pr-2 font-mono text-xs">{tool.tool}</td>
								<td class="py-1.5 text-right tabular-nums">{tool.calls}</td>
								<td
									class="w-16 py-1.5 text-right text-xs {tool.errors > 0
										? 'text-rose-600'
										: 'text-zinc-400'}"
								>
									{tool.errors} err
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</Card>
	</div>

	<Card
		title="Connect a client"
		description="Every client gets the same URL; keys decide what each one may call."
	>
		<code class="block rounded bg-zinc-100 px-3 py-2 text-xs break-all dark:bg-zinc-800"
			>{data.endpoint}</code
		>
		<p class="mt-2 text-xs text-zinc-500">
			<a class="underline" href={resolve('/admin/keys/new')}>Create a key</a> to see copy-paste config
			for Claude Code, Cursor, opencode and stdio-only clients.
		</p>
	</Card>

	<p class="text-xs text-zinc-400">
		Live pooled connections: {data.live}. Health is refreshed by the worker; force a check from an
		upstream page.
		{#if data.healthz.last_health_sweep}
			Last sweep {new Date(String(data.healthz.last_health_sweep)).toLocaleTimeString()}.
		{:else}
			No sweep has run yet — start the worker (bun run worker) for proactive health checks.
		{/if}
	</p>
</div>
