/** Status vocabulary shared by badges, dots, filters and charts. */
export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'unconfigured' | 'unknown';

export const HEALTH_LABEL: Record<HealthStatus, string> = {
	healthy: 'Healthy',
	degraded: 'Degraded',
	down: 'Down',
	unconfigured: 'Not configured',
	unknown: 'Unknown'
};

/** Classes are enumerated literally so Tailwind can see them at build time. */
export const HEALTH_CLASSES: Record<HealthStatus, string> = {
	healthy: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
	degraded: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
	down: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
	unconfigured: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
	unknown: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
};

export const HEALTH_DOT: Record<HealthStatus, string> = {
	healthy: 'bg-emerald-500',
	degraded: 'bg-amber-500',
	down: 'bg-rose-500',
	unconfigured: 'bg-sky-500',
	unknown: 'bg-zinc-400'
};

export function asHealth(value: string | null | undefined): HealthStatus {
	return value === 'healthy' || value === 'degraded' || value === 'down' || value === 'unconfigured'
		? value
		: 'unknown';
}

export const CALL_STATUS_LABEL: Record<string, string> = {
	ok: 'OK',
	error: 'Error',
	timeout: 'Timeout',
	rejected: 'Rejected',
	rate_limited: 'Rate limited'
};

export const CALL_STATUS_CLASSES: Record<string, string> = {
	ok: HEALTH_CLASSES.healthy,
	error: HEALTH_CLASSES.down,
	timeout: HEALTH_CLASSES.degraded,
	rejected: HEALTH_CLASSES.unconfigured,
	rate_limited: HEALTH_CLASSES.degraded
};
