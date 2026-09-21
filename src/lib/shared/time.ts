/**
 * ISO-8601 UTC helpers. The database stores timestamps as TEXT
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`), which sorts lexicographically = chronologically,
 * so all comparisons happen as plain string comparisons.
 */

export function nowIso(now: Date = new Date()): string {
	return now.toISOString();
}

/** `nowIso()` shifted by `offsetMs` (negative = past). */
export function isoFromNow(offsetMs: number, now: Date = new Date()): string {
	return new Date(now.getTime() + offsetMs).toISOString();
}

/** Truncate to the hour, e.g. `2026-09-21T14:00:00.000Z` (usage buckets). */
export function hourBucket(iso: string): string {
	return `${iso.slice(0, 13)}:00:00.000Z`;
}

/** `YYYY-MM-DD` in UTC — used for daily quota buckets. */
export function dayBucket(iso: string = new Date().toISOString()): string {
	return iso.slice(0, 10);
}

export function isIsoUtc(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value);
}

export function parseIso(value: string): Date | undefined {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** True when `iso` is at or before `reference` (both UTC strings). */
export function isPast(iso: string | null | undefined, reference: string = nowIso()): boolean {
	if (!iso) return false;
	return iso <= reference;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Human duration for the UI, e.g. `2h 5m`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const units: Array<[number, string]> = [
		[DAY, 'd'],
		[HOUR, 'h'],
		[MINUTE, 'm']
	];
	const parts: string[] = [];
	let rest = Math.round(ms);
	for (const [size, label] of units) {
		const value = Math.floor(rest / size);
		if (value > 0) {
			parts.push(`${value}${label}`);
			rest -= value * size;
		}
	}
	if (parts.length === 0) return `${Math.round(ms / 1000)}s`;
	return parts.slice(0, 2).join(' ');
}
