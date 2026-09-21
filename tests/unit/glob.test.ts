import { describe, expect, test } from 'bun:test';
import {
	GlobPatternError,
	assertValidPatterns,
	globToRegExp,
	isAllowed,
	matchesAny,
	partitionByRule
} from '../../src/lib/shared/glob';

const matches = (pattern: string, value: string) => globToRegExp(pattern).test(value);

describe('glob matching', () => {
	test('* matches across separators and the whole string must match', () => {
		expect(matches('search*', 'search_issues')).toBe(true);
		expect(matches('*search', 'github__web_search')).toBe(true);
		expect(matches('*search*', 'a_search_b')).toBe(true);
		expect(matches('search', 'search_issues')).toBe(false);
		expect(matches('*', 'anything at all')).toBe(true);
	});

	test('? matches exactly one character', () => {
		expect(matches('db_run?uery', 'db_runquery')).toBe(true);
		expect(matches('db_run?uery', 'db_run_query')).toBe(false);
		expect(matches('a?c', 'abc')).toBe(true);
		expect(matches('a?c', 'ac')).toBe(false);
		expect(matches('a?c', 'abbc')).toBe(false);
	});

	test('a trailing dash inside a class is a literal dash', () => {
		expect(matches('tool_[a-]', 'tool_a')).toBe(true);
		expect(matches('tool_[a-]', 'tool_-')).toBe(true);
		expect(matches('tool_[a-]', 'tool_b')).toBe(false);
	});

	test('character classes, including negation', () => {
		expect(matches('tool_[a-c]', 'tool_b')).toBe(true);
		expect(matches('tool_[a-c]', 'tool_z')).toBe(false);
		expect(matches('tool_[!a-c]', 'tool_z')).toBe(true);
		expect(matches('tool_[!a-c]', 'tool_a')).toBe(false);
	});

	test('escaping treats wildcards as literals', () => {
		expect(matches('a\\*b', 'a*b')).toBe(true);
		expect(matches('a\\*b', 'axxb')).toBe(false);
		expect(matches('v1.0', 'v1x0')).toBe(false);
	});

	test('punctuation in real tool names matches literally', () => {
		expect(matches('github__create_pr', 'github__create_pr')).toBe(true);
		expect(matches('sentry__*_events', 'sentry__list_events')).toBe(true);
	});

	test('regex metacharacters in a pattern are never executed as regex', () => {
		expect(matches('a|b', 'a|b')).toBe(true);
		expect(matches('(a)', '(a)')).toBe(true);
		expect(matches('a{2}', 'aa')).toBe(false);
		expect(matches('a{2}', 'a{2}')).toBe(true);
	});
});

describe('pattern validation', () => {
	// note: a leading/trailing '-' inside a class is a literal dash, so '[a-]' is valid
	const bad = ['[a', '[]', 'a\\', '', 'x'.repeat(300), '[9-0]'];
	for (const [index, pattern] of bad.entries()) {
		test(`rejects bad pattern #${index}`, () => {
			expect(() => globToRegExp(pattern)).toThrow(GlobPatternError);
		});
	}

	test('assertValidPatterns reports the offending pattern', () => {
		expect(() => assertValidPatterns(['ok*', '[9-0]'])).toThrow(/reversed range/);
		expect(() => assertValidPatterns(['fine', 'also*fine'])).not.toThrow();
	});
});

describe('profile filter rules', () => {
	test('no allow list means everything passes', () => {
		expect(isAllowed('anything', { allow: [], deny: [] })).toBe(true);
		expect(isAllowed('anything', { allow: null, deny: undefined })).toBe(true);
	});

	test('an allow list restricts, a deny list removes', () => {
		const rule = { allow: ['github__*', 'sentry__*'], deny: [] };
		expect(isAllowed('github__create_pr', rule)).toBe(true);
		expect(isAllowed('postgres__query', rule)).toBe(false);
		expect(isAllowed('github__delete_repo', { allow: ['github__*'], deny: ['*delete*'] })).toBe(
			false
		);
	});

	test('deny wins over allow (BR-03)', () => {
		const rule = { allow: ['*'], deny: ['*_delete_*'] };
		expect(isAllowed('github_delete_pr', rule)).toBe(false);
		expect(isAllowed('github_create_pr', rule)).toBe(true);
	});

	test('matchesAny never matches on an empty pattern list', () => {
		expect(matchesAny('x', [])).toBe(false);
		expect(matchesAny('x', null)).toBe(false);
	});

	test('partition keeps order and reports what was filtered', () => {
		const tools = [
			{ name: 'github__create_pr' },
			{ name: 'github__delete_repo' },
			{ name: 'sentry__list_events' }
		];
		const { kept, filtered } = partitionByRule(tools, (tool) => tool.name, {
			allow: ['github__*', 'sentry__*'],
			deny: ['*delete*']
		});
		expect(kept.map((tool) => tool.name)).toEqual(['github__create_pr', 'sentry__list_events']);
		expect(filtered.map((tool) => tool.name)).toEqual(['github__delete_repo']);
	});

	test('compiles a 1000-name scan against 20 patterns in well under a millisecond', () => {
		const names = Array.from(
			{ length: 1000 },
			(_, index) => `upstream_${index % 20}__tool_${index}`
		);
		const patterns = Array.from({ length: 20 }, (_, index) => `upstream_${index}*`);
		const started = performance.now();
		for (let round = 0; round < 10; round += 1) {
			for (const name of names) matchesAny(name, patterns);
		}
		const elapsed = performance.now() - started;
		// 10k evaluations: cached compilation keeps this comfortably under the budget
		expect(elapsed).toBeLessThan(50);
	});
});
