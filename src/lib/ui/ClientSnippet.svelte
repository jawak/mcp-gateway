<script lang="ts">
	import CopyButton from './CopyButton.svelte';

	/**
	 * Copy-paste client configuration (T-35).
	 *
	 * These are the exact shapes each client expects — a wrong shape is the most
	 * common reason a first connection fails, so the snippets are worth keeping
	 * literal rather than generated from a shared template.
	 */
	let { endpoint, key }: { endpoint: string; key: string } = $props();

	const clients = $derived([
		{
			id: 'claude-code',
			label: 'Claude Code',
			language: 'sh',
			body: `claude mcp add --transport http gateway ${endpoint} --header "Authorization: Bearer ${key}"`
		},
		{
			id: 'cursor',
			label: 'Cursor',
			language: 'json',
			body: JSON.stringify(
				{
					mcpServers: {
						gateway: {
							type: 'streamable-http',
							url: endpoint,
							headers: { Authorization: `Bearer ${key}` }
						}
					}
				},
				undefined,
				2
			),
			file: '.cursor/mcp.json'
		},
		{
			id: 'opencode',
			label: 'opencode',
			language: 'json',
			body: JSON.stringify(
				{
					mcp: {
						gateway: {
							type: 'remote',
							url: endpoint,
							enabled: true,
							headers: { Authorization: `Bearer ${key}` }
						}
					}
				},
				undefined,
				2
			),
			file: 'opencode.json'
		},
		{
			id: 'claude-remote',
			label: 'Claude Desktop / any OAuth-capable client',
			language: 'text',
			body: endpoint
		},
		{
			id: 'mcp-remote',
			label: 'Client that only speaks stdio (mcp-remote bridge)',
			language: 'json',
			body: JSON.stringify(
				{
					mcpServers: {
						gateway: {
							command: 'npx',
							args: ['-y', 'mcp-remote', endpoint, '--header', `Authorization: Bearer ${key}`]
						}
					}
				},
				undefined,
				2
			)
		}
	]);
</script>

<div class="space-y-3">
	{#each clients as client (client.id)}
		<div class="rounded-md border border-zinc-200 dark:border-zinc-800">
			<div
				class="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800"
			>
				<span class="text-sm font-medium">
					{client.label}
					{#if 'file' in client && client.file}
						<code class="ml-1 rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">{client.file}</code
						>
					{/if}
				</span>
				<CopyButton value={client.body} />
			</div>
			<pre class="overflow-x-auto px-3 py-2 text-xs leading-relaxed"><code>{client.body}</code
				></pre>
		</div>
	{/each}
	<p class="text-xs text-zinc-500">
		The key is shown once at creation. If it is lost, rotate the key — there is no way to read it
		back.
	</p>
</div>
