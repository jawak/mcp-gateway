import { describe, expect, test } from 'bun:test';
import { displayStatus } from '../../src/lib/server/upstream/health';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';

describe('displayStatus', () => {
	test('the newer upstream status row wins', () => {
		const result = displayStatus(
			{ state: 'unconfigured', checkedAt: T2, error: 'OAuth authorization required' },
			{ status: 'healthy', checkedAt: T1, error: null }
		);
		expect(result).toEqual({
			status: 'unconfigured',
			error: 'OAuth authorization required',
			checkedAt: T2,
			source: 'upstream'
		});
	});

	test('the newer health row wins', () => {
		const result = displayStatus(
			{ state: 'healthy', checkedAt: T1 },
			{ status: 'down', checkedAt: T2, error: 'ECONNREFUSED' }
		);
		expect(result).toEqual({
			status: 'down',
			error: 'ECONNREFUSED',
			checkedAt: T2,
			source: 'health'
		});
	});

	test('an unconfigured health row overrides an older healthy record', () => {
		const result = displayStatus(
			{ state: 'healthy', checkedAt: T1 },
			{ status: 'unconfigured', checkedAt: T2, error: 'OAuth authorization required' }
		);
		expect(result.status).toBe('unconfigured');
		expect(result.source).toBe('health');
		expect(result.error).toBe('OAuth authorization required');
	});

	test('a record without a timestamp falls back to the timestamped health row', () => {
		const result = displayStatus(
			{ state: 'unconfigured' },
			{ status: 'healthy', checkedAt: T1, error: null }
		);
		expect(result.status).toBe('healthy');
		expect(result.source).toBe('health');
	});

	test('a health row without a timestamp falls back to the timestamped record', () => {
		const result = displayStatus(
			{ state: 'unconfigured', checkedAt: T1 },
			{ status: 'healthy', checkedAt: '', error: null }
		);
		expect(result.status).toBe('unconfigured');
		expect(result.source).toBe('upstream');
	});

	test('missing timestamps on both sides fall back to the record, then health', () => {
		expect(
			displayStatus({ state: 'unconfigured' }, { status: 'healthy', checkedAt: '', error: null })
				.status
		).toBe('unconfigured');
		expect(displayStatus(null, { status: 'unconfigured', checkedAt: '', error: null }).status).toBe(
			'unconfigured'
		);
		expect(displayStatus(null, null)).toEqual({
			status: 'unknown',
			error: null,
			checkedAt: null,
			source: 'none'
		});
	});

	test('an invalid recorded state is unknown but keeps its error', () => {
		const result = displayStatus({ state: 'exploded', error: 'boom' }, null);
		expect(result.status).toBe('unknown');
		expect(result.error).toBe('boom');
		expect(result.source).toBe('none');
	});
});
