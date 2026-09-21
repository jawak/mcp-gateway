<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import Button from '$lib/ui/Button.svelte';
	import ThemeToggle from '$lib/ui/ThemeToggle.svelte';

	let {
		data,
		children
	}: {
		data: {
			user: { email: string; role: string };
			canWrite: boolean;
			summary?: { upstreams: number; profiles: number; keys: number; down: number };
		};
		children: Snippet;
	} = $props();

	const links = [
		{ href: '/admin', label: 'Dashboard' },
		{ href: '/admin/upstreams', label: 'Upstreams' },
		{ href: '/admin/profiles', label: 'Profiles' },
		{ href: '/admin/keys', label: 'API keys' },
		{ href: '/admin/logs', label: 'Logs' },
		{ href: '/admin/usage', label: 'Usage' },
		{ href: '/admin/templates', label: 'Templates' },
		{ href: '/admin/manifest', label: 'Manifest' },
		{ href: '/admin/users', label: 'Users' },
		{ href: '/admin/settings', label: 'Settings' }
	] as const;

	const isActive = (href: string) =>
		href === '/admin' ? page.url.pathname === '/admin' : page.url.pathname.startsWith(href);
</script>

<a
	href="#main"
	class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded focus:bg-zinc-900 focus:px-3 focus:py-2 focus:text-zinc-50"
	>Skip to content</a
>

<div class="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
	<aside
		class="border-b border-zinc-200 bg-white p-4 lg:border-r lg:border-b-0 dark:border-zinc-800 dark:bg-zinc-900"
	>
		<div class="flex items-center justify-between gap-2">
			<a href={resolve('/admin')} class="text-sm font-semibold tracking-tight">mcp-gateway</a>
			<ThemeToggle />
		</div>

		<nav class="mt-4 flex flex-wrap gap-1 lg:flex-col" aria-label="Admin">
			{#each links as link (link.href)}
				<a
					href={resolve(link.href)}
					aria-current={isActive(link.href) ? 'page' : undefined}
					class="rounded-md px-2.5 py-1.5 text-sm lg:block {isActive(link.href)
						? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'
						: 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}"
				>
					{link.label}
				</a>
			{/each}
		</nav>

		{#if data.summary}
			<dl class="mt-6 hidden gap-y-1 text-xs text-zinc-500 lg:grid">
				<div class="flex justify-between">
					<dt>Upstreams</dt>
					<dd>{data.summary.upstreams}</dd>
				</div>
				<div class="flex justify-between">
					<dt>Down</dt>
					<dd>{data.summary.down}</dd>
				</div>
				<div class="flex justify-between">
					<dt>Profiles</dt>
					<dd>{data.summary.profiles}</dd>
				</div>
				<div class="flex justify-between">
					<dt>Active keys</dt>
					<dd>{data.summary.keys}</dd>
				</div>
			</dl>
		{/if}
	</aside>

	<div class="flex min-h-dvh flex-col">
		<header
			class="flex items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-900"
		>
			<span class="truncate text-zinc-500">
				{data.user.email}
				<span class="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800"
					>{data.user.role}</span
				>
				{#if !data.canWrite}
					<span
						class="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200"
						>read-only</span
					>
				{/if}
			</span>
			<form method="POST" action="/logout">
				<Button variant="secondary">Sign out</Button>
			</form>
		</header>

		<main id="main" class="flex-1 p-4 lg:p-6">
			{@render children()}
		</main>
	</div>
</div>
