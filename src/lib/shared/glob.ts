/**
 * Glob matching for per-profile tool filters (T-11).
 *
 * Admins scope a profile with patterns like `search*`, `*_internal`,
 * `github__create_*` or `sentry__*`. Rules (BR-03):
 *  - `*` matches any run of characters, `?` exactly one
 *  - `[a-z]` / `[!a-z]` character classes are supported
 *  - `\` escapes the next character
 *  - a deny match always wins, even when an allow pattern also matches
 *
 * Patterns come from user input, so they are validated and translated to
 * anchored regular expressions (never `new RegExp(userInput)`), and a malformed
 * pattern is rejected with a clear message instead of silently matching nothing.
 */

export class GlobPatternError extends Error {
	readonly pattern: string;

	constructor(pattern: string, reason: string) {
		super(`invalid glob pattern "${pattern}": ${reason}`);
		this.name = 'GlobPatternError';
		this.pattern = pattern;
	}
}

const cache = new Map<string, RegExp>();

/** Translate one glob into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
	const cached = cache.get(pattern);
	if (cached) return cached;
	if (pattern.length === 0) throw new GlobPatternError(pattern, 'empty pattern');
	if (pattern.length > 256) throw new GlobPatternError(pattern, 'longer than 256 characters');

	let source = '^';
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index] as string;
		switch (char) {
			case '*':
				source += '[\\s\\S]*';
				break;
			case '?':
				source += '[\\s\\S]';
				break;
			case '\\': {
				const next = pattern[index + 1];
				if (next === undefined) throw new GlobPatternError(pattern, 'trailing escape');
				source += escapeRegExpChar(next);
				index += 1;
				break;
			}
			case '[': {
				const end = pattern.indexOf(']', index + 1);
				if (end === -1) throw new GlobPatternError(pattern, 'unterminated character class');
				let body = pattern.slice(index + 1, end);
				if (body.length === 0) throw new GlobPatternError(pattern, 'empty character class');
				let negated = false;
				if (body.startsWith('!') || body.startsWith('^')) {
					negated = true;
					body = body.slice(1);
				}
				// validate ranges: every `-` must sit between two characters
				for (let position = 0; position < body.length; position += 1) {
					if (body[position] !== '-') continue;
					if (position === 0 || position === body.length - 1) continue; // leading/trailing literal
					if (body.charCodeAt(position - 1) > body.charCodeAt(position + 1)) {
						throw new GlobPatternError(pattern, `reversed range in class [${body}]`);
					}
				}
				source += `[${negated ? '^' : ''}${body.replace(/([\\\]])/g, '\\$1')}]`;
				index = end;
				break;
			}
			default:
				source += escapeRegExpChar(char);
		}
	}
	source += '$';

	const compiled = new RegExp(source);
	cache.set(pattern, compiled);
	return compiled;
}

function escapeRegExpChar(char: string): string {
	return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** True when `value` matches any of `patterns`. Empty/undefined list never matches. */
export function matchesAny(value: string, patterns: readonly string[] | null | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

export type FilterRule = {
	allow: readonly string[] | null | undefined;
	deny: readonly string[] | null | undefined;
};

/**
 * Decide whether one tool name survives a profile's rules.
 * No allow list means "everything is allowed"; deny always wins.
 */
export function isAllowed(name: string, rule: FilterRule): boolean {
	if (matchesAny(name, rule.deny)) return false;
	if (!rule.allow || rule.allow.length === 0) return true;
	return matchesAny(name, rule.allow);
}

/** Split a list of names into kept and filtered-out, preserving order. */
export function partitionByRule<T>(
	items: readonly T[],
	nameOf: (item: T) => string,
	rule: FilterRule
) {
	const kept: T[] = [];
	const filtered: T[] = [];
	for (const item of items) (isAllowed(nameOf(item), rule) ? kept : filtered).push(item);
	return { kept, filtered };
}

/** Validate a whole pattern set up front (used by the admin form, FR-14). */
export function assertValidPatterns(patterns: readonly string[], label = 'pattern'): void {
	for (const pattern of patterns) {
		globToRegExp(pattern);
		if (pattern.length === 0) throw new GlobPatternError(pattern, `${label} must not be empty`);
	}
}

/** Test hook: drop the compiled-pattern cache. */
export function clearGlobCache(): void {
	cache.clear();
}
