<script lang="ts">
	import Card from '$lib/ui/Card.svelte';

	let { data } = $props();

	const peak = $derived(Math.max(1, ...data.series.map((point) => point.calls)));
	const width = $derived(Math.max(1, data.series.length));
	/** Bars as a path-free flex layout: readable, keyboard-free, and no chart library. */
	const bars = $derived(
		data.series.map((point) => ({
			...point,
			height: Math.round((point.calls / peak) * 100),
			errorHeight: point.calls > 0 ? Math.round((point.errors / point.calls) * 100) : 0,
			label: new Date(`${point.hour}T00:00:00Z`).toLocaleString(undefined, {
				month: 'short',
				day: 'numeric',
				hour: '2-digit'
			})
		}))
	);
	const totalCalls = $derived(data.series.reduce((sum, point) => sum + point.calls, 0));
	const totalErrors = $derived(data.series.reduce((sum, point) => sum + point.errors, 0));
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">Usage</h1>
			<p class="text-sm text-zinc-500">
				{totalCalls} calls · {totalErrors} failed in the last {data.hours}h.
			</p>
		</div>
		<form method="GET" class="flex items-center gap-2 text-sm">
			<label class="text-zinc-500" for="hours">Window</label>
			<select
				id="hours"
				name="hours"
				class="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
				onchange={(event) => {
					(event.currentTarget as HTMLSelectElement).form?.submit();
				}}
			>
				{#each data.windows as hours (hours)}
					<option value={hours} selected={hours === data.hours}>{hours}h</option>
				{/each}
			</select>
		</form>
	</div>

	<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
		<Card title="Calls (24h)">{data.stats.calls24h.toLocaleString()}</Card>
		<Card title="Error rate">{(data.stats.errorRate * 100).toFixed(1)}%</Card>
		<Card title="p50 / p95">{data.stats.p50Ms} ms / {data.stats.p95Ms} ms</Card>
		<Card title="Tools seen">{data.top.length}</Card>
	</div>

	<Card title="Calls per hour" description="Red portion of a bar is the failed share of that hour.">
		{#if totalCalls === 0}
			<p class="text-sm text-zinc-500">No calls in this window.</p>
		{:else}
			<div
				class="flex h-40 items-end gap-px"
				role="img"
				aria-label="Calls per hour, {totalCalls} total"
			>
				{#each bars as bar (bar.hour)}
					<div class="group relative flex-1 self-end" style="height: {Math.max(2, bar.height)}%">
						<div class="absolute inset-0 rounded-t bg-zinc-800 dark:bg-zinc-300"></div>
						{#if bar.errorHeight > 0}
							<div
								class="absolute inset-x-0 bottom-0 rounded-t bg-rose-500"
								style="height: {bar.errorHeight}%"
							></div>
						{/if}
						<span class="sr-only">{bar.label}: {bar.calls} calls, {bar.errors} failed</span>
					</div>
				{/each}
			</div>
			<div class="mt-1 flex justify-between text-xs text-zinc-500">
				<span>{bars[0]?.label}</span>
				<span>{bars[bars.length - 1]?.label}</span>
			</div>
			<p class="mt-1 text-xs text-zinc-400">Peak hour: {peak} calls · buckets: {width}</p>
		{/if}
	</Card>

	<div class="grid gap-4 lg:grid-cols-2">
		<Card title="Top tools" description="By call volume in the selected window">
			{#if data.top.length === 0}
				<p class="text-sm text-zinc-500">Nothing yet.</p>
			{:else}
				<table class="w-full text-sm">
					<thead class="text-left text-xs tracking-wide text-zinc-500 uppercase">
						<tr
							><th class="pb-1 font-medium">Tool</th><th class="pb-1 font-medium">Calls</th><th
								class="pb-1 font-medium">Failed</th
							><th class="pb-1 font-medium">p95</th></tr
						>
					</thead>
					<tbody class="divide-y divide-zinc-100 dark:divide-zinc-800">
						{#each data.top as tool (tool.tool)}
							<tr>
								<td class="py-1.5 pr-2 font-mono text-xs">{tool.tool}</td>
								<td class="py-1.5 tabular-nums">{tool.calls}</td>
								<td
									class="py-1.5 tabular-nums {tool.errors > 0 ? 'text-rose-600' : 'text-zinc-400'}"
									>{tool.errors}</td
								>
								<td class="py-1.5 text-right text-xs text-zinc-500 tabular-nums">{tool.p95Ms} ms</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</Card>

		<Card title="Per API key" description="Who is calling, and how much of it fails">
			{#if data.byKey.length === 0}
				<p class="text-sm text-zinc-500">No calls in this window.</p>
			{:else}
				<table class="w-full text-sm">
					<thead class="text-left text-xs tracking-wide text-zinc-500 uppercase">
						<tr
							><th class="pb-1 font-medium">Key</th><th class="pb-1 font-medium">Calls</th><th
								class="pb-1 font-medium">Failed</th
							></tr
						>
					</thead>
					<tbody class="divide-y divide-zinc-100 dark:divide-zinc-800">
						{#each data.byKey as entry (entry.keyName)}
							<tr>
								<td class="py-1.5 pr-2">{entry.keyName}</td>
								<td class="py-1.5 tabular-nums">{entry.calls}</td>
								<td
									class="py-1.5 tabular-nums {entry.errors > 0 ? 'text-rose-600' : 'text-zinc-400'}"
									>{entry.errors}</td
								>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</Card>
	</div>

	<p class="text-xs text-zinc-500">
		Numbers come from the retained call log (default 30 days). Older detail is pruned by the
		retention job, so long-range trends need the hourly rollup.
	</p>
</div>
