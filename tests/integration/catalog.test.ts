/**
 * Catalog tests (T-14 + T-15): fan-out, caching, filtering, collisions, paging.
 * A fake pool keeps the assertions about gateway behaviour free of processes.
 */
import { describe, expect, test } from 'bun:test';
import { ToolCatalog, qualifyUri, unqualifyUri } from '../../src/lib/server/mcp/catalog';
import { UpstreamPool } from '../../src/lib/server/upstream/pool';
import type { UpstreamHandle, UpstreamRecord } from '../../src/lib/server/upstream/types';
import { createProfile, getSnapshot, reload, setProfileLinks } from '../../src/lib/server/registry';
import { events } from '../../src/lib/server/registry/events';
import { getDb, useDatabaseForTests } from '../../src/lib/server/db';
import { runMigrations } from '../../src/lib/server/db/migrate';
import { eq } from 'drizzle-orm';
import { upstreamHealth, upstreams } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/shared/ids';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'mcpgw-catalog-'));
process.env.MCPGW_DATA_DIR = dir;
process.env.MCPGW_MASTER_KEY = '2'.repeat(64);
runMigrations({ dataDir: dir });
useDatabaseForTests(path.join(dir, 'mcpgw.db'));

type ToolSpec = { name: string; description?: string; inputSchema?: Record<string, unknown> };

/** Pool double: per-slug tool/resource/prompt fixtures plus call counters. */
function fakePool(
	fixture: Record<
		string,
		{
			tools?: ToolSpec[];
			fail?: string;
			resources?: Array<{ uri: string; name: string }>;
			prompts?: Array<{ name: string; description?: string }>;
		}
	>
) {
	const hits: Record<string, number> = {};
	const pool = new UpstreamPool({
		connect: async (record: UpstreamRecord) => {
			hits[record.slug] = (hits[record.slug] ?? 0) + 1;
			const entry = fixture[record.slug] ?? {};
			if (entry.fail) throw new Error(entry.fail);
			return {
				slug: record.slug,
				transport: 'stdio',
				connected: true,
				inFlight: 0,
				async ensureAlive() {},
				async close() {},
				diagnostics: () => ({}),
				client: () => ({}) as never,
				async listTools() {
					hits[`${record.slug}:tools`] = (hits[`${record.slug}:tools`] ?? 0) + 1;
					return {
						tools: (entry.tools ?? []).map((tool) => ({
							name: tool.name,
							...(tool.description ? { description: tool.description } : {}),
							inputSchema: tool.inputSchema ?? { type: 'object' }
						}))
					};
				},
				async callTool() {
					return { content: [{ type: 'text', text: 'ok' }] };
				},
				async listResources() {
					return { resources: entry.resources ?? [] };
				},
				async readResource() {
					return { contents: [] };
				},
				async listPrompts() {
					return { prompts: entry.prompts ?? [] };
				},
				async getPrompt() {
					return { messages: [] };
				},
				async ping() {
					return { latencyMs: 1 };
				}
			} as unknown as UpstreamHandle;
		}
	});
	return { pool, hits };
}

/** Insert an upstream row and return the record from the fresh snapshot. */
function persistUpstream(slug: string, pin: 'pinned' | 'lazy' = 'pinned'): UpstreamRecord {
	getDb()
		.insert(upstreams)
		.values({
			id: uuidv7(),
			slug,
			name: slug,
			transport: 'stdio',
			connection: { command: 'true' },
			pin,
			enabled: true
		})
		.onConflictDoNothing()
		.run();
	reload(getDb());
	const record = getSnapshot().upstreamsBySlug.get(slug);
	if (!record) throw new Error(`upstream ${slug} missing after insert`);
	return record;
}

function profileWith(
	slugs: string[],
	globs: Record<string, { allow?: string[]; deny?: string[] }> = {}
) {
	const links = slugs.map((slug) => {
		const record = getSnapshot().upstreamsBySlug.get(slug);
		if (!record) throw new Error(`unknown slug ${slug}`);
		return {
			upstreamId: record.id,
			allowGlobs: globs[slug]?.allow,
			denyGlobs: globs[slug]?.deny
		};
	});
	return createProfile({ name: `catalog-${uuidv7().slice(-8)}`, links });
}

function catalogFor(
	fixture: Parameters<typeof fakePool>[0],
	options: { ttlMs?: number; skipUnhealthy?: boolean; pageSize?: number } = {}
) {
	const { pool, hits } = fakePool(fixture);
	const catalog = new ToolCatalog({
		pool,
		ttlMs: options.ttlMs ?? 60_000,
		skipUnhealthy: options.skipUnhealthy ?? false,
		pageSize: options.pageSize,
		log: {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined
		} as never
	});
	return { catalog, pool, hits };
}

describe('fan-out', () => {
	test('merges tools from every upstream in scope, namespaced and sorted', async () => {
		const a = persistUpstream('cat-a');
		const b = persistUpstream('cat-b');
		const profile = profileWith([a.slug, b.slug]);
		const { catalog } = catalogFor({
			'cat-a': { tools: [{ name: 'search', description: 'Search code' }] },
			'cat-b': { tools: [{ name: 'list_events' }, { name: 'get_issue' }] }
		});
		const page = await catalog.listTools(profile.id);
		expect(page.items.map((tool) => tool.name)).toEqual([
			'cat-a__search',
			'cat-b__get_issue',
			'cat-b__list_events'
		]);
		expect(page.items[0]?.description).toBe('Search code');
		expect(page.items[0]?.meta).toEqual({
			upstream: 'cat-a',
			upstreamTool: 'search',
			health: 'unknown'
		});
		expect(page.items[0]?.inputSchema).toEqual({ type: 'object' });
	});

	test('one failing upstream does not take the catalog down, and is reported (BR-04)', async () => {
		const good = persistUpstream('cat-good');
		const bad = persistUpstream('cat-bad');
		const profile = profileWith([good.slug, bad.slug]);
		const { catalog } = catalogFor({
			'cat-good': { tools: [{ name: 'ok' }] },
			'cat-bad': { fail: 'spawn failed' }
		});
		const page = await catalog.listTools(profile.id);
		expect(page.items.map((tool) => tool.name)).toEqual(['cat-good__ok']);
		const stats = catalog.stats();
		expect(stats.cached.find((entry) => entry.slug === 'cat-bad')?.error).toContain('spawn failed');
	});

	test('disabled upstreams are skipped without connecting', async () => {
		const off = persistUpstream('cat-off');
		getDb().update(upstreams).set({ enabled: false }).where(eq(upstreams.id, off.id)).run();
		reload(getDb());
		const profile = profileWith([off.slug]);
		const { catalog, hits } = catalogFor({ 'cat-off': { tools: [{ name: 'nope' }] } });
		expect((await catalog.listTools(profile.id)).items).toEqual([]);
		expect(hits['cat-off'] ?? 0).toBe(0);
	});
});

describe('cache', () => {
	test('a second call is served from the cache; invalidate() forces a refetch', async () => {
		const record = persistUpstream('cat-cache');
		const profile = profileWith([record.slug]);
		const { catalog, hits } = catalogFor({ 'cat-cache': { tools: [{ name: 'once' }] } });
		await catalog.listTools(profile.id);
		await catalog.listTools(profile.id);
		expect(hits['cat-cache:tools']).toBe(1);

		catalog.invalidate('cat-cache');
		await catalog.listTools(profile.id);
		expect(hits['cat-cache:tools']).toBe(2);
	});

	test('the TTL expires an entry', async () => {
		const record = persistUpstream('cat-ttl');
		const profile = profileWith([record.slug]);
		const { catalog, hits } = catalogFor(
			{ 'cat-ttl': { tools: [{ name: 'tick' }] } },
			{ ttlMs: 1 }
		);
		await catalog.listTools(profile.id);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await catalog.listTools(profile.id);
		expect(hits['cat-ttl:tools']).toBe(2);
	});

	test('registry and health events invalidate the cache', async () => {
		const record = persistUpstream('cat-events');
		const profile = profileWith([record.slug]);
		const { catalog, hits } = catalogFor({ 'cat-events': { tools: [{ name: 'live' }] } });
		// event dispatch is asynchronous, so let the queue drain before asserting
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
		const off = catalog.watchInvalidations();
		await catalog.listTools(profile.id);
		events.emit('upstream.changed', { slug: 'cat-events', enabled: true });
		await settle();
		await catalog.listTools(profile.id);
		expect(hits['cat-events:tools']).toBe(2);
		events.emit('health.changed', { slug: 'cat-events', status: 'healthy', previous: 'down' });
		await settle();
		await catalog.listTools(profile.id);
		expect(hits['cat-events:tools']).toBe(3);
		off();
		events.emit('upstream.changed', { slug: 'cat-events', enabled: true });
		await settle();
		await catalog.listTools(profile.id);
		expect(hits['cat-events:tools']).toBe(3);
	});

	test('concurrent listTools shares one upstream fetch', async () => {
		const record = persistUpstream('cat-dedupe');
		const profile = profileWith([record.slug]);
		const { catalog, hits } = catalogFor({ 'cat-dedupe': { tools: [{ name: 'once' }] } });
		await Promise.all([
			catalog.listTools(profile.id),
			catalog.listTools(profile.id),
			catalog.listTools(profile.id)
		]);
		expect(hits['cat-dedupe:tools']).toBe(1);
	});
});

describe('profile filters (BR-03)', () => {
	test('patterns match the client-visible qualified name; deny wins', async () => {
		const record = persistUpstream('cat-filter');
		// admin rules are written against what the dashboard shows: qualified names
		const profile = profileWith([record.slug], {
			'cat-filter': { allow: ['cat-filter__create_*', 'cat-filter__list_*'], deny: ['*secret*'] }
		});
		const { catalog } = catalogFor({
			'cat-filter': {
				tools: [
					{ name: 'create_pr' },
					{ name: 'list_repos' },
					{ name: 'delete_secret' },
					{ name: 'list_secrets' }
				]
			}
		});
		expect((await catalog.listTools(profile.id)).items.map((tool) => tool.name)).toEqual([
			'cat-filter__create_pr',
			'cat-filter__list_repos'
		]);
	});

	test('a filtered-out tool is also unresolvable, so it cannot be called by guessing', async () => {
		const record = persistUpstream('cat-guard');
		const profile = profileWith([record.slug], { 'cat-guard': { deny: ['*delete*'] } });
		const { catalog } = catalogFor({
			'cat-guard': { tools: [{ name: 'delete_repo' }, { name: 'create_pr' }] }
		});
		expect(await catalog.resolve(profile.id, 'cat-guard__delete_repo')).toBeUndefined();
		expect(await catalog.resolve(profile.id, 'cat-guard__create_pr')).toMatchObject({
			upstream: { slug: 'cat-guard' },
			original: 'create_pr'
		});
	});

	test('filters are re-evaluated per call, not baked into the cache', async () => {
		const record = persistUpstream('cat-live');
		const profile = profileWith([record.slug]);
		const { catalog, hits } = catalogFor({ 'cat-live': { tools: [{ name: 'a' }, { name: 'b' }] } });
		expect((await catalog.listTools(profile.id)).items).toHaveLength(2);

		// an operator tightens the rule; the cached upstream set must not mask it
		setProfileLinks(profile.id, [{ upstreamId: record.id, allowGlobs: ['*_a'] }]);
		const after = await catalog.listTools(profile.id);
		expect(after.items.map((tool) => tool.name)).toEqual(['cat-live__a']);
		// ...and the upstream itself was not asked again (only the rule changed)
		expect(hits['cat-live:tools']).toBe(1);
	});
});

describe('collisions', () => {
	test('a colliding name is dropped and reported, never silently shadowed', async () => {
		const record = persistUpstream('collide');
		const profile = profileWith([record.slug]);
		const { catalog } = catalogFor({
			collide: { tools: [{ name: 'a:b' }, { name: 'a/b' }] } // both qualify to collide__a_b
		});
		const page = await catalog.listTools(profile.id);
		expect(page.items.map((tool) => tool.name)).toEqual(['collide__a_b']);
		const conflicts = catalog.conflicts();
		expect(conflicts.collide).toHaveLength(1);
		expect(conflicts.collide?.[0]?.qualified).toBe('collide__a_b');
	});

	test('the same tool name in two upstreams is not a collision', async () => {
		const a = persistUpstream('same-a');
		const b = persistUpstream('same-b');
		const profile = profileWith([a.slug, b.slug]);
		const { catalog } = catalogFor({
			'same-a': { tools: [{ name: 'search' }] },
			'same-b': { tools: [{ name: 'search' }] }
		});
		expect((await catalog.listTools(profile.id)).items.map((tool) => tool.name)).toEqual([
			'same-a__search',
			'same-b__search'
		]);
		expect(catalog.conflicts()).toEqual({});
	});
});

describe('resources, prompts and paging', () => {
	test('resource URIs are qualified and reversible', async () => {
		const record = persistUpstream('res-a');
		const profile = profileWith([record.slug]);
		const { catalog } = catalogFor({
			'res-a': { resources: [{ uri: 'github://prs', name: 'prs' }] }
		});
		const page = await catalog.listResources(profile.id);
		expect(page.items[0]?.uri).toBe('github://res-a__prs');
		const resolved = await catalog.resolveResourceUri(profile.id, 'github://res-a__prs');
		expect(resolved?.uri).toBe('github://prs');
		expect(qualifyUri('a', 'x://y')).toBe('x://a__y');
		expect(unqualifyUri('x://a__y')).toEqual({ slug: 'a', uri: 'x://y' });
		expect(unqualifyUri('no-scheme')).toBeUndefined();
	});

	test('prompt names are namespaced and resolvable', async () => {
		const record = persistUpstream('prompt-a');
		const profile = profileWith([record.slug]);
		const { catalog } = catalogFor({
			'prompt-a': { prompts: [{ name: 'review', description: 'Review a PR' }] }
		});
		const page = await catalog.listPrompts(profile.id);
		expect(page.items[0]?.name).toBe('prompt-a__review');
		expect(await catalog.resolvePromptName(profile.id, 'prompt-a__review')).toMatchObject({
			name: 'review'
		});
		expect(await catalog.resolvePromptName(profile.id, 'other__review')).toBeUndefined();
	});

	test('paging walks the catalog with an opaque cursor', async () => {
		const record = persistUpstream('paged');
		const profile = profileWith([record.slug]);
		const { catalog } = catalogFor(
			{ paged: { tools: Array.from({ length: 5 }, (_, index) => ({ name: `tool_${index}` })) } },
			{ pageSize: 2 }
		);
		const first = await catalog.listTools(profile.id);
		expect(first.items.map((tool) => tool.name)).toEqual(['paged__tool_0', 'paged__tool_1']);
		expect(first.nextCursor).toBeTruthy();
		const second = await catalog.listTools(profile.id, { cursor: first.nextCursor });
		expect(second.items.map((tool) => tool.name)).toEqual(['paged__tool_2', 'paged__tool_3']);
		const third = await catalog.listTools(profile.id, { cursor: second.nextCursor });
		expect(third.items.map((tool) => tool.name)).toEqual(['paged__tool_4']);
		expect(third.nextCursor).toBeUndefined();
	});
});

describe('health awareness', () => {
	test('upstreams marked down are skipped without a connection attempt', async () => {
		const record = persistUpstream('sick');
		getDb()
			.insert(upstreamHealth)
			.values({
				id: uuidv7(),
				upstreamId: record.id,
				status: 'down',
				ok: false,
				checkedAt: new Date().toISOString()
			})
			.run();
		const profile = profileWith([record.slug]);
		const { catalog, hits } = catalogFor(
			{ sick: { tools: [{ name: 'x' }] } },
			{ skipUnhealthy: true }
		);
		expect((await catalog.listTools(profile.id)).items).toEqual([]);
		expect(hits['sick'] ?? 0).toBe(0);
	});

	test('an upstream that recovered is used again once the cache is invalidated', async () => {
		const record = persistUpstream('recovering');
		getDb()
			.insert(upstreamHealth)
			.values({
				id: uuidv7(),
				upstreamId: record.id,
				status: 'down',
				ok: false,
				checkedAt: new Date(Date.now() - 60_000).toISOString()
			})
			.run();
		const profile = profileWith([record.slug]);
		const { catalog, hits } = catalogFor(
			{ recovering: { tools: [{ name: 'x' }] } },
			{ skipUnhealthy: true }
		);
		// production wires this up at boot; without it nothing clears on health.changed
		const off = catalog.watchInvalidations();
		await catalog.listTools(profile.id);
		getDb()
			.insert(upstreamHealth)
			.values({
				id: uuidv7(),
				upstreamId: record.id,
				status: 'healthy',
				ok: true,
				checkedAt: new Date().toISOString()
			})
			.run();
		// health.changed clears both the catalog and the health snapshot cache
		events.emit('health.changed', { slug: 'recovering', status: 'healthy', previous: 'down' });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await catalog.listTools(profile.id);
		expect(hits['recovering:tools']).toBe(1);
		off();
	});
});

describe('stats', () => {
	test('reports cached upstreams with age and profile count', async () => {
		const record = persistUpstream('stat-me');
		const profile = profileWith([record.slug]);
		const { catalog } = catalogFor({ 'stat-me': { tools: [{ name: 'a' }] } });
		await catalog.listTools(profile.id);
		const stats = catalog.stats();
		expect(stats.profiles).toBeGreaterThanOrEqual(1);
		const entry = stats.cached.find((item) => item.slug === 'stat-me');
		expect(entry?.tools).toBe(1);
		expect(entry?.ageMs).toBeGreaterThanOrEqual(0);
		rmSync(dir, { recursive: true, force: true });
	});
});
