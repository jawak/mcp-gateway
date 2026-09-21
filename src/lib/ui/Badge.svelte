<script lang="ts">
	import { HEALTH_CLASSES, HEALTH_DOT, HEALTH_LABEL, asHealth, type HealthStatus } from './tokens';

	let {
		status,
		label,
		dot = false,
		title
	}: { status: HealthStatus | string; label?: string; dot?: boolean; title?: string } = $props();

	const health = $derived(asHealth(status));
</script>

<span
	{title}
	class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium {HEALTH_CLASSES[
		health
	]}"
>
	{#if dot}<span class="size-1.5 rounded-full {HEALTH_DOT[health]}" aria-hidden="true"></span>{/if}
	{label ?? HEALTH_LABEL[health]}
</span>
