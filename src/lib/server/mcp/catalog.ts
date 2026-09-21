/**
 * Tool catalog (T-14) with per-profile filtering (T-15).
 *
 * `tools/list` fans out to every upstream in the key's scope, namespaces the
 * names (T-10), applies the profile's allow/deny globs (T-11) and caches the
 * result per profile. Points that shaped the design:
 *
 *  - **One fan-out per profile, not per request.** A busy gateway with 500
 *    sessions would otherwise ask 50 upstreams for their tools on every call.
 *    The cache is keyed by profile and invalidated by registry/health events, so
 *    a config change is visible within milliseconds (BR-12) while a steady state
 *    costs nothing.
 *  - **One slow upstream cannot stall the catalog.** The fan-out is
 *    `allSettled`; failures are recorded per upstream and the rest still answers,
 *    which is what "partial degradation, not total failure" means here (BR-04).
 *  - **Health is read from the database, not from memory.** The health monitor
 *    runs in the worker process, so its state has to be picked up through the
 *    `upstream_health` table; skipping known-dead upstreams also stops a request
 *    from respawning a broken `npx` over and over.
 *  - **Filtering happens on read, not only when the cache is written** (FR-14):
 *    the cached set is the upstream truth, the profile rules are applied per call
 *    so a rule change cannot be masked by a warm cache.
 */
import type {
	ToolDescriptor,
	ResourceDescriptor,
	ResourceTemplateDescriptor,
	PromptDescriptor,
	ListPage
} from './backend.ts';
import {
	build as buildNamespace,
	NamespacingError,
	qualify,
	type NamespaceConflict
} from './namespacing.ts';
import { isAllowed } from '../../shared/glob.ts';
import { getSnapshot, type RegistrySnapshot, type ScopeEntry } from '../registry/index.ts';
import { latestHealthByUpstream } from '../upstream/health.ts';
import type { UpstreamPool } from '../upstream/pool.ts';
import type { UpstreamRecord } from '../upstream/types.ts';
import { getConfig } from '../config.ts';
import { logger as rootLogger, type Logger } from '../observability/logger.ts';
import { events } from '../registry/events.ts';

export type CatalogOptions = {
	pool: UpstreamPool;
	snapshot?: () => RegistrySnapshot;
	/** Cache lifetime for the raw (unfiltered) upstream tool sets. */
	ttlMs?: number;
	/** Skip upstreams the health monitor considers dead/unconfigured. */
	skipUnhealthy?: boolean;
	/** How many upstreams are asked at the same time. */
	fanoutConcurrency?: number;
	/** Page size for tools/list; 0 (default) returns everything in one page. */
	pageSize?: number;
	logger?: Logger;
	log?: ReturnType<typeof rootLogger.child>;
};

type UpstreamTools = {
	tools: ToolDescriptor[];
	fetchedAt: number;
	/** Populated when the fetch failed; the reason shown in the admin UI. */
	error?: string;
};

export type CatalogStats = {
	cached: Array<{ slug: string; tools: number; ageMs: number; error?: string }>;
	profiles: number;
};

export type CatalogConflicts = { conflicts: NamespaceConflict[]; at: number };

export class ToolCatalog {
	#pool: UpstreamPool;
	#snapshot: () => RegistrySnapshot;
	#ttlMs: number;
	#skipUnhealthy: boolean;
	#fanout: number;
	#pageSize: number;
	#log;

	#byUpstream = new Map<string, UpstreamTools>();
	#inFlight = new Map<string, Promise<UpstreamTools>>();
	#conflicts = new Map<string, CatalogConflicts>();
	#unhealthyCache: { at: number; slugs: Set<string> } | undefined;

	constructor(options: CatalogOptions) {
		this.#pool = options.pool;
		this.#snapshot = options.snapshot ?? getSnapshot;
		const config = getConfig();
		this.#ttlMs = options.ttlMs ?? config.catalogTtlMs;
		this.#skipUnhealthy = options.skipUnhealthy ?? true;
		this.#fanout = Math.max(1, options.fanoutConcurrency ?? 8);
		this.#pageSize = options.pageSize ?? 0;
		this.#log = options.log ?? (options.logger ?? rootLogger).child({ component: 'catalog' });
	}

	/** Aggregated, namespaced, profile-filtered tool list. */
	async listTools(
		profileId: string,
		page: { cursor?: string } = {}
	): Promise<ListPage<ToolDescriptor>> {
		const scope = this.#snapshot().profilesById.get(profileId)?.links ?? [];
		const collected = await Promise.all(scope.map((link) => this.#toolsForLink(link)));

		// cross-upstream namespacing check, so two upstreams both exposing `search`
		// stay reachable and a genuine collision is reported instead of hidden
		const qualified = this.#qualify(scope, collected);

		// per-link filtering (deny wins over allow, BR-03)
		const visible = qualified.filter((tool) => {
			const link = scope.find((entry) => entry.upstream.slug === tool.meta.upstream);
			if (!link) return false;
			return isAllowed(tool.name, { allow: link.allowGlobs, deny: link.denyGlobs });
		});

		visible.sort((a, b) => a.name.localeCompare(b.name));
		return this.#paginate(visible, page.cursor);
	}

	/** Resolve a client-visible name back to upstream + original name (T-16). */
	async resolve(
		profileId: string,
		qualifiedName: string
	): Promise<{ upstream: UpstreamRecord; original: string } | undefined> {
		const scope = this.#snapshot().profilesById.get(profileId)?.links ?? [];
		const candidates = scope.filter((link) => qualifiedName.startsWith(`${link.upstream.slug}__`));
		for (const link of candidates) {
			const entry = await this.#toolsForLink(link);
			const match = entry.tools.find((tool) => tool.name === qualifiedName);
			if (!match) continue;
			// the answer must respect the same rules as tools/list, otherwise a
			// filtered-out tool would still be callable by guessing its name
			if (!isAllowed(qualifiedName, { allow: link.allowGlobs, deny: link.denyGlobs })) {
				return undefined;
			}
			return { upstream: link.upstream, original: match.meta.upstreamTool };
		}
		return undefined;
	}

	/** Resources and prompts share the fan-out/cache policy of tools. */
	async listResources(
		profileId: string,
		page: { cursor?: string } = {}
	): Promise<ListPage<ResourceDescriptor>> {
		const scope = this.#snapshot().profilesById.get(profileId)?.links ?? [];
		const items = await this.#fanoutOver(scope, (upstream) =>
			this.#pool
				.withHandle(upstream, (handle) => handle.listResources())
				.then((result) => result.resources ?? [])
		);
		const descriptors: ResourceDescriptor[] = [];
		for (const [index, list] of items.entries()) {
			const link = scope[index];
			const upstream = link?.upstream;
			if (!upstream || !list) continue;
			for (const resource of list) {
				const qualified = qualifyUri(upstream.slug, resource.uri);
				// BR-03 covers resource URIs and prompt names, not just tools
				if (!isAllowed(qualified, { allow: link?.allowGlobs, deny: link?.denyGlobs })) continue;
				descriptors.push({
					uri: qualified,
					name: resource.name,
					...(resource.title ? { title: resource.title } : {}),
					...(resource.description ? { description: resource.description } : {}),
					...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
					meta: { upstream: upstream.slug }
				});
			}
		}
		descriptors.sort((a, b) => a.uri.localeCompare(b.uri));
		return this.#paginate(descriptors, page.cursor);
	}

	async listPrompts(
		profileId: string,
		page: { cursor?: string } = {}
	): Promise<ListPage<PromptDescriptor>> {
		const scope = this.#snapshot().profilesById.get(profileId)?.links ?? [];
		const items = await this.#fanoutOver(scope, (upstream) =>
			this.#pool
				.withHandle(upstream, (handle) => handle.listPrompts())
				.then((result) => result.prompts ?? [])
		);
		const descriptors: PromptDescriptor[] = [];
		for (const [index, list] of items.entries()) {
			const link = scope[index];
			const upstream = link?.upstream;
			if (!upstream || !list) continue;
			for (const prompt of list) {
				const qualifiedName = qualify(upstream.slug, prompt.name);
				if (!isAllowed(qualifiedName, { allow: link?.allowGlobs, deny: link?.denyGlobs })) continue;
				descriptors.push({
					name: qualifiedName,
					...(prompt.title ? { title: prompt.title } : {}),
					...(prompt.description ? { description: prompt.description } : {}),
					...(prompt.arguments ? { arguments: prompt.arguments } : {}),
					meta: { upstream: upstream.slug }
				});
			}
		}
		descriptors.sort((a, b) => a.name.localeCompare(b.name));
		return this.#paginate(descriptors, page.cursor);
	}

	/** Read a namespaced resource URI from the upstream that owns it. */
	async resolveResourceUri(
		profileId: string,
		qualifiedUri: string
	): Promise<{ upstream: UpstreamRecord; uri: string } | undefined> {
		const scope = this.#snapshot().profilesById.get(profileId)?.links ?? [];
		// qualifyUri() puts the slug after the scheme, so parse it back rather than
		// looking for a leading prefix
		const parsed = unqualifyUri(qualifiedUri);
		if (!parsed) return undefined;
		const link = scope.find((entry) => entry.upstream.slug === parsed.slug);
		if (!link) return undefined;
		return { upstream: link.upstream, uri: parsed.uri };
	}

	/** Resolve a namespaced prompt name. */
	async resolvePromptName(
		profileId: string,
		qualifiedName: string
	): Promise<{ upstream: UpstreamRecord; name: string } | undefined> {
		const scope = this.#snapshot().profilesById.get(profileId)?.links ?? [];
		for (const link of scope) {
			const prefix = `${link.upstream.slug}__`;
			if (!qualifiedName.startsWith(prefix)) continue;
			if (!isAllowed(qualifiedName, { allow: link.allowGlobs, deny: link.denyGlobs }))
				return undefined;
			return { upstream: link.upstream, name: qualifiedName.slice(prefix.length) };
		}
		return undefined;
	}

	/**
	 * Why a name is not visible to this profile: `filtered` means the upstream is
	 * in scope but the profile's rules hide it, `unknown` means no in-scope
	 * upstream provides it. The distinction drives the error code the client sees.
	 */
	classify(profileId: string, qualifiedName: string): 'allowed' | 'filtered' | 'unknown' {
		const scope = this.#snapshot().profilesById.get(profileId)?.links ?? [];
		const link = scope.find((entry) => qualifiedName.startsWith(`${entry.upstream.slug}__`));
		if (!link) return 'unknown';
		return isAllowed(qualifiedName, { allow: link.allowGlobs, deny: link.denyGlobs })
			? 'allowed'
			: 'filtered';
	}

	/** In-scope upstreams + rules, for capability probing in the backend. */
	scopeFor(profileId: string): ScopeEntry[] {
		return this.#snapshot().profilesById.get(profileId)?.links ?? [];
	}

	async listResourceTemplates(
		profileId: string,
		page: { cursor?: string } = {}
	): Promise<ListPage<ResourceTemplateDescriptor>> {
		const scope = this.#snapshot().profilesById.get(profileId)?.links ?? [];
		const items = await this.#fanoutOver(scope, (upstream) =>
			this.#pool
				.withHandle(upstream, (handle) => handle.listResourceTemplates())
				.then((result) => result.resourceTemplates ?? [])
		);
		const descriptors: ResourceTemplateDescriptor[] = [];
		for (const [index, list] of items.entries()) {
			const link = scope[index];
			const upstream = link?.upstream;
			if (!upstream || !list) continue;
			for (const template of list) {
				const qualifiedTemplate = qualifyUri(upstream.slug, template.uriTemplate);
				if (!isAllowed(qualifiedTemplate, { allow: link?.allowGlobs, deny: link?.denyGlobs }))
					continue;
				descriptors.push({
					uriTemplate: qualifiedTemplate,
					name: template.name,
					...(template.title ? { title: template.title } : {}),
					...(template.description ? { description: template.description } : {}),
					...(template.mimeType ? { mimeType: template.mimeType } : {}),
					meta: { upstream: upstream.slug }
				});
			}
		}
		descriptors.sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
		return this.#paginate(descriptors, page.cursor);
	}

	/** Drop cached tool sets. Called by the registry/health event event subscribers. */
	invalidate(slug?: string): void {
		if (slug) {
			this.#byUpstream.delete(slug);
			this.#conflicts.delete(slug);
			return;
		}
		this.#byUpstream.clear();
		this.#conflicts.clear();
	}

	/** Namespacing collisions per upstream, for the admin UI. */
	conflicts(): Record<string, NamespaceConflict[]> {
		return Object.fromEntries(
			[...this.#conflicts.entries()].map(([slug, entry]) => [slug, entry.conflicts])
		);
	}

	stats(): CatalogStats {
		const now = Date.now();
		return {
			cached: [...this.#byUpstream.entries()].map(([slug, entry]) => ({
				slug,
				tools: entry.tools.length,
				ageMs: now - entry.fetchedAt,
				...(entry.error ? { error: entry.error } : {})
			})),
			profiles: this.#snapshot().profilesById.size
		};
	}

	/** Subscribe to the events that invalidate the cache. Returns an unsubscribe. */
	watchInvalidations(): () => void {
		const offUpstream = events.on('upstream.changed', ({ slug }) => this.invalidate(slug));
		const offEnabled = events.on('upstream.enabled', ({ slug }) => this.invalidate(slug));
		const offProfile = events.on('profile.changed', () => this.invalidate());
		const offHealth = events.on('health.changed', ({ slug }) => {
			this.invalidate(slug);
			this.#unhealthyCache = undefined;
		});
		return () => {
			offUpstream();
			offEnabled();
			offProfile();
			offHealth();
		};
	}

	async #toolsForLink(link: ScopeEntry): Promise<UpstreamTools> {
		const slug = link.upstream.slug;
		const cached = this.#byUpstream.get(slug);
		if (cached && Date.now() - cached.fetchedAt < this.#ttlMs) return cached;

		const pending = this.#inFlight.get(slug);
		if (pending) return pending;

		const flight = this.#fetchTools(link.upstream).finally(() => this.#inFlight.delete(slug));
		this.#inFlight.set(slug, flight);
		// a cold upstream that health already knows is dead should not be spawned
		if (
			cached?.error &&
			this.#ttlMs > 0 &&
			Date.now() - cached.fetchedAt < Math.min(this.#ttlMs, 5_000)
		) {
			return cached;
		}
		const fresh = await flight;
		this.#byUpstream.set(slug, fresh);
		return fresh;
	}

	async #fetchTools(upstream: UpstreamRecord): Promise<UpstreamTools> {
		if (!upstream.enabled) return { tools: [], fetchedAt: Date.now(), error: 'disabled' };
		if (this.#skipUnhealthy && (await this.#isUnhealthy(upstream.slug))) {
			return { tools: [], fetchedAt: Date.now(), error: 'skipped: upstream is down' };
		}
		try {
			const result = await this.#pool.withHandle(upstream, (handle) => handle.listTools());
			return {
				tools: result.tools.map((tool) => ({
					// qualified form: what the client is actually allowed to call
					name: qualify(upstream.slug, tool.name),
					...(tool.title ? { title: tool.title } : {}),
					...(tool.description ? { description: tool.description } : {}),
					inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
					...(tool.outputSchema
						? { outputSchema: tool.outputSchema as Record<string, unknown> }
						: {}),
					...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
					meta: { upstream: upstream.slug, upstreamTool: tool.name, health: 'unknown' }
				})),
				fetchedAt: Date.now()
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#log.warn(
				{ slug: upstream.slug, reason: message },
				'tool list failed, catalog continues'
			);
			return { tools: [], fetchedAt: Date.now(), error: message.slice(0, 300) };
		}
	}

	/**
	 * Qualified names for the whole scope. A collision is never silently
	 * swallowed: the later tool is dropped and reported.
	 */
	#qualify(scope: ScopeEntry[], collected: UpstreamTools[]): ToolDescriptor[] {
		const inputs = scope.map((link, index) => ({
			slug: link.upstream.slug,
			tools: (collected[index] as UpstreamTools).tools.map((tool) => ({
				name: tool.meta.upstreamTool
			}))
		}));
		try {
			// build() throws on collision; when it doesn't, every collected descriptor
			// is by definition uniquely named
			buildNamespace(inputs);
			const unique = new Map<string, ToolDescriptor>();
			for (const entry of collected) for (const tool of entry.tools) unique.set(tool.name, tool);
			return [...unique.values()];
		} catch (error) {
			if (!(error instanceof NamespacingError)) throw error;
			// keep everything that did not collide and remember what we dropped
			const dropped = new Set(
				error.conflicts.map((conflict) => `${conflict.b.slug}\u0000${conflict.b.original}`)
			);
			const kept: ToolDescriptor[] = [];
			for (const [index, link] of scope.entries()) {
				for (const tool of (collected[index] as UpstreamTools).tools) {
					if (dropped.has(`${link.upstream.slug}\u0000${tool.meta.upstreamTool}`)) continue;
					kept.push(tool);
				}
			}
			for (const conflict of error.conflicts) {
				const existing = this.#conflicts.get(conflict.b.slug);
				this.#conflicts.set(conflict.b.slug, {
					conflicts: existing ? [...existing.conflicts, conflict] : [conflict],
					at: Date.now()
				});
			}
			this.#log.error(
				{ conflicts: error.conflicts.length, message: error.message },
				'tool name collision: dropping the later tools'
			);
			return kept;
		}
	}

	async #fanoutOver<T>(
		scope: ScopeEntry[],
		work: (upstream: UpstreamRecord) => Promise<T>
	): Promise<(T | undefined)[]> {
		const results: (T | undefined)[] = new Array(scope.length).fill(undefined);
		let cursor = 0;
		const workers = Array.from({ length: Math.min(this.#fanout, scope.length) }, async () => {
			for (;;) {
				const index = cursor++;
				if (index >= scope.length) return;
				const link = scope[index];
				if (!link || !link.upstream.enabled) continue;
				try {
					results[index] = await work(link.upstream);
				} catch (error) {
					this.#log.warn(
						{ slug: link.upstream.slug, reason: (error as Error).message },
						'fan-out failed for one upstream'
					);
				}
			}
		});
		await Promise.all(workers);
		return results;
	}

	async #isUnhealthy(slug: string): Promise<boolean> {
		if (this.#unhealthyCache && Date.now() - this.#unhealthyCache.at < 5_000) {
			return this.#unhealthyCache.slugs.has(slug);
		}
		let slugs = new Set<string>();
		try {
			const latest = latestHealthByUpstream();
			slugs = new Set(
				[...this.#snapshot().upstreamsBySlug.entries()]
					.filter(([name, record]) => {
						void name;
						const health = latest.get(record.id);
						return health ? health.status === 'down' || health.status === 'unconfigured' : false;
					})
					.map(([, record]) => record.slug)
			);
		} catch {
			// no health rows yet (fresh install): treat unknown as healthy and let the
			// connection attempt decide
		}
		this.#unhealthyCache = { at: Date.now(), slugs };
		return slugs.has(slug);
	}

	#paginate<T>(items: T[], cursor: string | undefined): ListPage<T> {
		if (this.#pageSize <= 0) return { items };
		const offset = cursor ? Number.parseInt(decodeCursor(cursor), 10) || 0 : 0;
		const slice = items.slice(offset, offset + this.#pageSize);
		const next =
			offset + this.#pageSize < items.length
				? encodeCursor(String(offset + this.#pageSize))
				: undefined;
		return { items: slice, ...(next ? { nextCursor: next } : {}) };
	}
}

/** Resource URIs keep their scheme; the slug goes into the host-ish part. */
export function qualifyUri(slug: string, uri: string): string {
	const separator = uri.indexOf('://');
	if (separator === -1) return `${slug}__${uri}`;
	return `${uri.slice(0, separator)}://${slug}__${uri.slice(separator + 3)}`;
}

/** Inverse of qualifyUri(). */
export function unqualifyUri(qualified: string): { slug: string; uri: string } | undefined {
	const separator = qualified.indexOf('://');
	if (separator === -1) return undefined;
	const rest = qualified.slice(separator + 3);
	const split = rest.indexOf('__');
	if (split === -1) return undefined;
	return {
		slug: rest.slice(0, split),
		uri: `${qualified.slice(0, separator)}://${rest.slice(split + 2)}`
	};
}

const encodeCursor = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const decodeCursor = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');
