<script lang="ts">
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import Badge from '$lib/ui/Badge.svelte';
	import Button from '$lib/ui/Button.svelte';
	import Card from '$lib/ui/Card.svelte';

	let { data, form } = $props();
	const ended = $derived(page.url.searchParams.get('ended'));
	const reset = $derived(page.url.searchParams.get('reset') === '1');

	let resetting = $state('');
	let creating = $state(false);
</script>

<div class="space-y-4">
	<div>
		<h1 class="text-lg font-semibold">Users</h1>
		<p class="text-sm text-zinc-500">
			{data.users.length} account{data.users.length === 1 ? '' : 's'} · {data.adminCount} active admin
			·
			{data.sessions} active dashboard session{data.sessions === 1 ? '' : 's'}
		</p>
	</div>

	{#if reset}
		<p
			class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
		>
			Password reset; that account's sessions were ended.
		</p>
	{/if}
	{#if ended !== null && ended !== ''}
		<p
			class="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
		>
			{ended} live session{ended === '1' ? '' : 's'} ended.
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

	<Card title="Accounts">
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead class="text-left text-xs tracking-wide text-zinc-500 uppercase">
					<tr>
						<th class="pr-3 pb-2 font-medium">Email</th>
						<th class="pr-3 pb-2 font-medium">Role</th>
						<th class="pr-3 pb-2 font-medium">Status</th>
						<th class="pr-3 pb-2 font-medium">Sign-in state</th>
						<th class="pb-2 font-medium">Actions</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-zinc-100 dark:divide-zinc-800">
					{#each data.users as user (user.id)}
						<tr>
							<td class="py-2 pr-3">
								{user.email}
								{#if user.isSelf}<span class="ml-1 text-xs text-zinc-500">(you)</span>{/if}
							</td>
							<td class="py-2 pr-3">
								<Badge status={user.role === 'admin' ? 'healthy' : 'unknown'} label={user.role} />
							</td>
							<td class="py-2 pr-3 text-xs">{user.status}</td>
							<td class="py-2 pr-3 text-xs">
								{#if user.locked}
									<span class="text-amber-600"
										>locked until {new Date(String(user.lockedUntil)).toLocaleTimeString()}</span
									>
								{:else if user.failedAttempts > 0}
									{user.failedAttempts} failed attempt{user.failedAttempts === 1 ? '' : 's'}
								{:else}
									—
								{/if}
							</td>
							<td class="py-2">
								<div class="flex flex-wrap gap-2">
									{#if user.role === 'admin'}
										<form method="POST" action="?/setRole" use:enhance>
											<input type="hidden" name="id" value={user.id} />
											<input type="hidden" name="role" value="viewer" />
											<Button variant="ghost" submit>Make viewer</Button>
										</form>
									{:else}
										<form method="POST" action="?/setRole" use:enhance>
											<input type="hidden" name="id" value={user.id} />
											<input type="hidden" name="role" value="admin" />
											<Button variant="ghost" submit>Make admin</Button>
										</form>
									{/if}
									<form method="POST" action="?/setStatus" use:enhance>
										<input type="hidden" name="id" value={user.id} />
										<input
											type="hidden"
											name="status"
											value={user.status === 'active' ? 'disabled' : 'active'}
										/>
										<Button variant="ghost" submit
											>{user.status === 'active' ? 'Disable' : 'Enable'}</Button
										>
									</form>
									<Button
										variant="ghost"
										onclick={() => (resetting = resetting === user.id ? '' : user.id)}
									>
										Reset password
									</Button>
								</div>
								{#if resetting === user.id}
									<form method="POST" action="?/resetPassword" class="mt-2 flex gap-2" use:enhance>
										<input type="hidden" name="id" value={user.id} />
										<input
											name="password"
											type="password"
											required
											minlength={data.minPassword}
											autocomplete="new-password"
											placeholder="new password (min {data.minPassword})"
											class="w-64 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
										/>
										<Button submit variant="secondary">Reset</Button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="mt-2 text-xs text-zinc-500">
			The last active admin cannot be demoted or disabled, and no account can remove its own admin
			role. Disabling an account ends its sessions immediately.
		</p>
	</Card>

	<Card title="Add account">
		{#if creating}
			<form method="POST" action="?/create" class="grid gap-3 sm:grid-cols-4" use:enhance>
				<label class="space-y-1 text-sm sm:col-span-2">
					<span class="text-zinc-500">Email</span>
					<input
						name="email"
						type="email"
						required
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<label class="space-y-1 text-sm">
					<span class="text-zinc-500">Role</span>
					<select
						name="role"
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					>
						<option value="viewer">viewer (read-only)</option>
						<option value="admin">admin</option>
					</select>
				</label>
				<label class="space-y-1 text-sm sm:col-span-2">
					<span class="text-zinc-500">Password (min {data.minPassword})</span>
					<input
						name="password"
						type="password"
						required
						minlength={data.minPassword}
						autocomplete="new-password"
						class="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
				</label>
				<div class="flex items-end gap-2 sm:col-span-2">
					<Button submit>Create account</Button>
					<Button variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
				</div>
			</form>
		{:else}
			<Button onclick={() => (creating = true)}>Add account</Button>
		{/if}
	</Card>
</div>
