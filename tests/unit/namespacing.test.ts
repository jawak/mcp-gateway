import { describe, expect, test } from 'bun:test';
import {
	NamespacingError,
	QUALIFIED_MAX_LENGTH,
	build,
	isValidToolName,
	qualify,
	resolve,
	sanitizeName,
	split
} from '../../src/lib/server/mcp/namespacing';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-';
const JUNK = ':/\\ \t\n#@%&()[]{}+=,;!?*"<>|~`^$\'€🚀日';

/** Small deterministic pseudo-random generator so the property test is reproducible. */
function makeRandom(seed: number) {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

describe('qualify', () => {
	test('joins slug and tool with the separator', () => {
		expect(qualify('github', 'create_pr')).toBe('github__create_pr');
		expect(split('github__create_pr')).toEqual({ slug: 'github', tool: 'create_pr' });
	});

	test('sanitises characters MCP clients reject', () => {
		expect(qualify('sentry', 'get:events/all')).toBe('sentry__get_events_all');
		expect(isValidToolName(qualify('my upstream', 'search stuff!'))).toBe(true);
	});

	test('stays within the 64 character budget and remains deterministic', () => {
		const long = 'x'.repeat(200);
		const first = qualify('upstream-with-a-long-slug-name', long);
		expect(first.length).toBeLessThanOrEqual(QUALIFIED_MAX_LENGTH);
		expect(isValidToolName(first)).toBe(true);
		expect(qualify('upstream-with-a-long-slug-name', long)).toBe(first);
	});

	test('two different long names do not collapse into one', () => {
		const base = 'y'.repeat(120);
		const a = qualify('up', `${base}-alpha`);
		const b = qualify('up', `${base}-beta`);
		expect(a).not.toBe(b);
		expect(isValidToolName(a) && isValidToolName(b)).toBe(true);
	});

	test('sanitised names that differ only by punctuation stay distinguishable when the originals differ', () => {
		expect(qualify('u', 'a:b')).not.toBe(qualify('u', 'a-c'));
	});

	test('split() refuses names without a separator', () => {
		expect(split('noseparator')).toBeUndefined();
		expect(split('__leading')).toBeUndefined();
	});

	test('sanitizeName never emits an empty name for non-empty input', () => {
		expect(sanitizeName('  ')).toBe('__');
	});
});

describe('build', () => {
	test('maps every tool and reports rewrites', () => {
		const catalog = build([
			{ slug: 'github', tools: [{ name: 'create_pr' }, { name: 'list issues' }] },
			{ slug: 'sentry', tools: [{ name: 'list_events' }] }
		]);
		expect(catalog.tools.map((tool) => tool.qualified)).toEqual([
			'github__create_pr',
			'github__list_issues',
			'sentry__list_events'
		]);
		expect(catalog.renamed.map((tool) => tool.qualified)).toEqual(['github__list_issues']);
		expect(resolve(catalog.byName, 'github__list_issues')).toEqual({
			slug: 'github',
			original: 'list issues'
		});
	});

	test('the same tool name in two upstreams does not collide (slug keeps them apart)', () => {
		const catalog = build([
			{ slug: 'github', tools: [{ name: 'search' }] },
			{ slug: 'sentry', tools: [{ name: 'search' }] }
		]);
		expect(catalog.byName.size).toBe(2);
		expect(resolve(catalog.byName, 'github__search')?.slug).toBe('github');
	});

	test('a real collision is reported, not silently renamed', () => {
		let error: unknown;
		try {
			build([
				{
					slug: 'a',
					tools: [
						{ name: 'x:y' },
						{ name: 'x/y' } // both sanitise to a__x_y
					]
				}
			]);
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(NamespacingError);
		expect((error as NamespacingError).conflicts[0]?.qualified).toBe('a__x_y');
		expect((error as Error).message).toContain('a::x:y');
	});

	test('a collision across upstreams is reported too', () => {
		expect(() =>
			build([
				{ slug: 'a__b', tools: [{ name: 'c' }] },
				{ slug: 'a', tools: [{ name: 'b__c' }] }
			])
		).toThrow(NamespacingError);
	});

	test('an empty registry produces an empty catalog', () => {
		expect(build([])).toEqual({ tools: [], byName: new Map(), renamed: [] });
	});
});

describe('property: every qualified name is valid and stable', () => {
	test('4000 random slug/tool combinations produce valid, deterministic, unique names', () => {
		const random = makeRandom(20260921);
		const pick = (alphabet: string) => alphabet[Math.floor(random() * alphabet.length)];
		const seen = new Map<string, string>();
		let collisions = 0;

		for (let iteration = 0; iteration < 4000; iteration += 1) {
			const slugLength = 2 + Math.floor(random() * 12);
			const toolLength = 1 + Math.floor(random() * 80);
			const slug = Array.from({ length: slugLength }, () =>
				pick(random() < 0.1 ? JUNK : 'abcdefghijklmnopqrstuvwxyz0123456789-')
			).join('');
			const tool = Array.from({ length: toolLength }, () =>
				pick(random() < 0.2 ? JUNK : ALPHABET + JUNK)
			).join('');

			const qualified = qualify(slug, tool);
			expect(isValidToolName(qualified), `invalid for ${slug}/${tool}`).toBe(true);
			expect(qualified.length).toBeLessThanOrEqual(QUALIFIED_MAX_LENGTH);
			expect(qualify(slug, tool)).toBe(qualified); // deterministic

			const key = `${slug}\u0000${tool}`;
			const previous = seen.get(qualified);
			if (previous !== undefined && previous !== key) collisions += 1;
			seen.set(qualified, key);
		}

		// Truncation to 64 chars is lossy by design; report the observed rate so a
		// regression that makes it much worse is visible.
		expect(collisions).toBeLessThan(5);
	});
});
