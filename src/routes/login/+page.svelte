<script lang="ts">
	type FormShape = { email?: string; message?: string; locked?: boolean } | undefined;
	let { form, data } = $props<{ form: FormShape; data: { next: string } }>();
</script>

<main class="grid min-h-dvh place-content-center bg-zinc-950 p-6 text-zinc-100">
	<div class="w-full max-w-sm space-y-6">
		<header class="space-y-1">
			<h1 class="text-xl font-semibold">mcp-gateway</h1>
			<p class="text-sm text-zinc-400">Admin sign in</p>
		</header>

		<form method="POST" action="?/login" class="space-y-4">
			<input type="hidden" name="next" value={data?.next ?? '/admin'} />

			<label class="block space-y-1">
				<span class="text-sm text-zinc-300">Email</span>
				<input
					name="email"
					type="email"
					autocomplete="username"
					required
					value={form?.email ?? ''}
					class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-400"
				/>
			</label>

			<label class="block space-y-1">
				<span class="text-sm text-zinc-300">Password</span>
				<input
					name="password"
					type="password"
					autocomplete="current-password"
					required
					class="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-400"
				/>
			</label>

			{#if form?.message}
				<p
					class="rounded-md px-3 py-2 text-sm {form.locked
						? 'bg-amber-950 text-amber-200'
						: 'bg-rose-950 text-rose-200'}"
					role="alert"
				>
					{form.message}
				</p>
			{/if}

			<button
				type="submit"
				class="w-full rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
			>
				Sign in
			</button>
		</form>
	</div>
</main>
