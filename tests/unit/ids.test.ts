import { describe, expect, test } from 'bun:test';
import { isUuid, timeFromUuidv7, uuidv7 } from '../../src/lib/shared/ids';
import {
	dayBucket,
	formatDuration,
	hourBucket,
	isPast,
	isoFromNow
} from '../../src/lib/shared/time';

describe('uuidv7', () => {
	test('looks like a v7 UUID with the RFC 4122 variant', () => {
		const id = uuidv7();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(isUuid(id)).toBe(true);
	});

	test('sorts by creation time', () => {
		const earlier = uuidv7(Date.parse('2026-01-01T00:00:00.000Z'));
		const later = uuidv7(Date.parse('2026-12-31T00:00:00.000Z'));
		expect(earlier.localeCompare(later)).toBeLessThan(0);
	});

	test('round-trips its embedded timestamp', () => {
		const ts = Date.parse('2026-09-21T05:00:00.000Z');
		expect(timeFromUuidv7(uuidv7(ts))).toBe(ts);
	});

	test('does not repeat within a burst', () => {
		const ids = new Set(Array.from({ length: 2000 }, () => uuidv7()));
		expect(ids.size).toBe(2000);
	});

	test('rejects v4 and malformed ids', () => {
		expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true); // v4 is a valid UUID
		expect(isUuid('not-a-uuid')).toBe(false);
		expect(isUuid('0198aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(false); // bad variant
	});
});

describe('time helpers', () => {
	test('hourBucket truncates to the hour', () => {
		expect(hourBucket('2026-09-21T14:37:12.481Z')).toBe('2026-09-21T14:00:00.000Z');
	});

	test('dayBucket returns the UTC date', () => {
		expect(dayBucket('2026-09-21T23:59:59.999Z')).toBe('2026-09-21');
	});

	test('isoFromNow shifts in both directions', () => {
		const base = new Date('2026-09-21T12:00:00.000Z');
		expect(isoFromNow(60_000, base)).toBe('2026-09-21T12:01:00.000Z');
		expect(isoFromNow(-1000, base)).toBe('2026-09-21T11:59:59.000Z');
	});

	test('isPast treats null as "never expires"', () => {
		expect(isPast(null)).toBe(false);
		expect(isPast(isoFromNow(-1))).toBe(true);
		expect(isPast(isoFromNow(60_000))).toBe(false);
	});

	test('formatDuration is compact enough for table cells', () => {
		expect(formatDuration(250)).toBe('250ms');
		expect(formatDuration(9_400)).toBe('9s');
		expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
	});
});
