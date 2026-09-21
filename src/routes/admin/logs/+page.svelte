<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import Badge from '$lib/ui/Badge.svelte';
	import Card from '$lib/ui/Card.svelte';
	import Pagination from '$lib/ui/Pagination.svelte';
	import { CALL_STATUS_LABEL } from '$lib/ui/tokens';

	let { data } = $props();

	const hoursOptions = [1, 6, 24, 72, 168];
	const statuses = ['ok', 'error', 'timeout', 'rejected', 'rate_limited'];

	// Filters live in the URL so a view is shareable and survives reloads. The result
	// is the current document with params changed, so base-path handling comes from
	// page.url itself — hence the rule disabled at each use site below.
	function hrefWith(values: Record<string, string | number>): string {
		const url = new URL(page.url);
		for (const [key, value] of Object.entries(values)) {
			if (value === '' || value === 0) url.searchParams.delete(key);
			else url.searchParams.set(key, String(value));
		}
		return `${url.pathname}${url.search}`;
	}
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold">Call log</h1>
			<p class="text-sm text-zinc-500">{data.total} matching call{data.total === 1 ? '' : 's'}.</p>
		</div>
		<!-- export uses the same filters as the page -->
		<a
			class="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
			href="{resolve(
				'/api/v1/logs/export.csv'
			)}?hours={data.hours}&status={data.status}&key={data.keyId}&tool={data.tool}"
		>
			Export CSV
		</a>
	</div>

	<form method="GET" class="flex flex-wrap items-end gap-2 text-sm">
		<label class="space-y-1">
			<span class="block text-xs text-zinc-500">Window</span>
			<select
				name="hours"
				class="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
			>
				{#each hoursOptions as hours (hours)}
					<option value={hours} selected={hours === data.hours}>{hours}h</option>
				{/each}
			</select>
		</label>
		<label class="space-y-1">
			<span class="block text-xs text-zinc-500">Status</span>
			<select
				name="status"
				class="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
			>
				<option value="">all</option>
				{#each statuses as value (value)}
					<option {value} selected={value === data.status}>{CALL_STATUS_LABEL[value]}</option>
				{/each}
			</select>
		</label>
		<label class="space-y-1">
			<span class="block text-xs text-zinc-500">Key</span>
			<select
				name="key"
				class="rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
			>
				<option value="">all</option>
				{#each data.keys as key (key.id)}
					<option value={key.id} selected={key.id === data.keyId}>{key.name}</option>
				{/each}
			</select>
		</label>
		<label class="space-y-1">
			<span class="block text-xs text-zinc-500">Tool</span>
			<input
				name="tool"
				value={data.tool}
				placeholder="github__create_pr"
				class="w-44 rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
			/>
		</label>
		<label class="space-y-1">
			<span class="block text-xs text-zinc-500">Request id</span>
			<input
				name="request"
				value={data.requestId}
				placeholder="paste to trace one call"
				class="w-56 rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
			/>
		</label>
		<button
			type="submit"
			class="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
			>Filter</button
		>
	</form>

	{#if data.foundViaRequestId}
		<p
			class="rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:bg-sky-950 dark:text-sky-200"
		>
			Showing every record for request id <code>{data.requestId}</code> ({data.rows.length} found), ignoring
			the time window.
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="underline" href={hrefWith({ request: '' })}>Clear</a>
		</p>
	{/if}

	<Card>
		{#if data.rows.length === 0}
			<p class="text-sm text-zinc-500">Nothing in this window. Connect a client and call a tool.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="text-left text-xs tracking-wide text-zinc-500 uppercase">
						<tr>
							<th class="pr-3 pb-2 font-medium">When</th>
							<th class="pr-3 pb-2 font-medium">Key</th>
							<th class="pr-3 pb-2 font-medium">Tool</th>
							<th class="pr-3 pb-2 font-medium">Status</th>
							<th class="pr-3 pb-2 font-medium">ms</th>
							<th class="pr-3 pb-2 font-medium">Bytes</th>
							<th class="pb-2 font-medium">Request</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-zinc-100 dark:divide-zinc-800">
						{#each data.rows as row (row.id)}
							<tr>
								<td class="py-2 pr-3 text-xs text-zinc-500"
									>{new Date(row.calledAt).toLocaleString()}</td
								>
								<td class="py-2 pr-3 text-xs">{row.keyName ?? '—'}</td>
								<td class="py-2 pr-3">
									<span class="font-mono text-xs">{row.tool}</span>
									{#if row.upstreamSlug}<span class="block text-xs text-zinc-500"
											>via {row.upstreamSlug}</span
										>{/if}
								</td>
								<td class="py-2 pr-3"
									><Badge
										status={row.status === 'ok'
											? 'healthy'
											: row.status === 'timeout' || row.status === 'rate_limited'
												? 'degraded'
												: 'down'}
										label={CALL_STATUS_LABEL[row.status] ?? row.status}
									/></td
								>
								<td class="py-2 pr-3 tabular-nums">{row.durationMs}</td>
								<td class="py-2 pr-3 text-xs text-zinc-500 tabular-nums"
									>{row.reqBytes ?? 0}→{row.resBytes ?? 0}</td
								>
								<td class="py-2">
									<!-- eslint-disable svelte/no-navigation-without-resolve -->
									<a
										class="font-mono text-xs underline"
										href={hrefWith({ request: row.requestId })}
										title="Trace this call">{row.requestId.slice(0, 8)}…</a
									>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								</td>
							</tr>
							{#if row.error}
								<tr>
									<td colspan="7" class="pb-2">
										<p
											class="rounded bg-rose-50 px-2 py-1 font-mono text-xs text-rose-800 dark:bg-rose-950 dark:text-rose-200"
										>
											{row.error}
										</p>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		<div class="mt-3">
			<Pagination total={data.total} perPage={data.perPage} baseUrl="/admin/logs" />
		</div>
	</Card>

	<p class="text-xs text-zinc-500">
		Error text is redacted before it is stored, so a token in an upstream response cannot end up in
		this table.
	</p>
</div>
