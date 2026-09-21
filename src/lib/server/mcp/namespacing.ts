/**
 * Tool namespacing (T-10).
 *
 * The gateway exposes tools from many upstreams through one `tools/list`, so two
 * upstreams both offering `search` would collide — and clients could not tell
 * which one they were calling, nor could we route the call back. Every name is
 * therefore qualified as `<slug>__<tool>` and sanitised to the character set
 * that MCP clients accept:
 *
 *     ^[A-Za-z0-9_.-]{1,64}$
 *
 * Rules (BR-01):
 *  - characters outside that set are replaced with `_`
 *  - names longer than 64 characters are shortened with a deterministic hash so
 *    the same input always produces the same output (a stable name matters: clients
 *    cache tool lists and users write prompts referring to them)
 *  - two different tools that would produce the same qualified name are reported
 *    as a collision; we never silently rename, because the second tool would
 *    become unreachable without anyone noticing
 */
import { createHash } from 'node:crypto';

export const QUALIFIED_MAX_LENGTH = 64;
const VALID_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SEPARATOR = '__';

export type QualifiedTool = {
	/** Name shown to the client. */
	qualified: string;
	slug: string;
	/** Name to send back to the upstream. */
	original: string;
	/** True when sanitisation or truncation changed the original name. */
	renamed: boolean;
};

export type NamespaceInput = {
	slug: string;
	tools: Array<{ name: string }>;
};

export type NamespaceConflict = {
	qualified: string;
	a: { slug: string; original: string };
	b: { slug: string; original: string };
};

export class NamespacingError extends Error {
	readonly conflicts: NamespaceConflict[];

	constructor(conflicts: NamespaceConflict[]) {
		super(
			`tool name collision after namespacing: ${conflicts
				.map((c) => `${c.qualified} (${c.a.slug}::${c.a.original} vs ${c.b.slug}::${c.b.original})`)
				.join(', ')}`
		);
		this.name = 'NamespacingError';
		this.conflicts = conflicts;
	}
}

const REPLACEMENT_CHAR = '_';

/** Replace anything outside [A-Za-z0-9_.-] with `_`. */
export function sanitizeName(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, REPLACEMENT_CHAR);
}

function shortHash(value: string, length: number): string {
	// base32-ish alphabet: lowercase alphanumerics, safe in tool names
	return createHash('sha1').update(value, 'utf8').digest('hex').slice(0, length);
}

/**
 * Build the client-visible name for `slug::original`.
 * Deterministic: the same inputs always yield the same output.
 */
export function qualify(slug: string, original: string): string {
	const safeSlug = sanitizeName(slug);
	const safeTool = sanitizeName(original);
	const direct = `${safeSlug}${SEPARATOR}${safeTool}`;
	if (direct.length <= QUALIFIED_MAX_LENGTH) return direct;

	// Keep both parts recognisable and append a hash of the full name so distinct
	// long names do not collapse into the same truncated prefix.
	const slugBudget = 12;
	const toolBudget = 31;
	const hash = shortHash(`${safeSlug}${SEPARATOR}${safeTool}`, 6);
	const head = safeSlug.slice(0, slugBudget);
	const tail = safeTool.slice(0, toolBudget);
	return `${head}-${hash}${SEPARATOR}${tail}-${hash}`;
}

/** True when `name` is a valid MCP tool name. */
export function isValidToolName(name: string): boolean {
	return VALID_NAME.test(name);
}

/** Split a qualified name back into slug + qualified tool part. */
export function split(qualified: string): { slug: string; tool: string } | undefined {
	const index = qualified.indexOf(SEPARATOR);
	if (index <= 0) return undefined;
	return { slug: qualified.slice(0, index), tool: qualified.slice(index + SEPARATOR.length) };
}

export type CatalogShape = {
	tools: QualifiedTool[];
	/** Fast lookup used by the request router. */
	byName: Map<string, { slug: string; original: string }>;
	/** Names that were rewritten (sanitised or truncated), for the admin UI. */
	renamed: QualifiedTool[];
};

/**
 * Qualify every tool of every upstream in scope.
 * @throws NamespacingError when two tools would map to the same name.
 */
export function build(upstreams: NamespaceInput[]): CatalogShape {
	const tools: QualifiedTool[] = [];
	const byName = new Map<string, { slug: string; original: string }>();
	const conflicts: NamespaceConflict[] = [];

	for (const upstream of upstreams) {
		for (const tool of upstream.tools) {
			const qualified = qualify(upstream.slug, tool.name);
			const existing = byName.get(qualified);
			if (existing) {
				conflicts.push({
					qualified,
					a: existing,
					b: { slug: upstream.slug, original: tool.name }
				});
				continue;
			}
			const entry: QualifiedTool = {
				qualified,
				slug: upstream.slug,
				original: tool.name,
				renamed: qualified !== `${upstream.slug}${SEPARATOR}${tool.name}`
			};
			tools.push(entry);
			byName.set(qualified, { slug: upstream.slug, original: tool.name });
		}
	}

	if (conflicts.length > 0) throw new NamespacingError(conflicts);
	return { tools, byName, renamed: tools.filter((tool) => tool.renamed) };
}

/** Resolve a client-visible name back to the upstream + original name. */
export function resolve(
	byName: Map<string, { slug: string; original: string }>,
	qualified: string
) {
	return byName.get(qualified);
}
