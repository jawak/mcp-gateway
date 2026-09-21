/**
 * Manifest import/export (T-20).
 *
 * `gateway.yaml` is what makes a self-hosted gateway reproducible: an operator
 * checks it into git, and CI ships it. The rules that matter:
 *
 *  - **Secrets are never inlined.** Values are references — `${ENV_VAR}` or
 *    `secret:<name>` — and an import that looks like it contains a real
 *    credential is rejected with the offending field named. A token that lands
 *    in git is gone, so failing loudly here is the only safe behaviour (BR-09).
 *  - **Import is idempotent.** Applying the same file twice reports everything
 *    unchanged and writes nothing.
 *  - **Removals disable, never delete.** Deleting an upstream a dashboard user is
 *    relying on would be a silent outage; disabling it drops it from catalogs while
 *    keeping the configuration recoverable.
 */
import yaml from 'yaml';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Db } from '../db/index.ts';
import { profileUpstreams, profiles, upstreams } from '../db/schema.ts';
import { uuidv7 } from '../../shared/ids.ts';
import { nowIso } from '../../shared/time.ts';
import { assertValidSlug, getSnapshot, reload } from './index.ts';
import { findSecretLike } from '../security/redact.ts';
import { events } from './events.ts';
import { recordAudit } from '../observability/audit.ts';

const upstreamSchema = z.object({
	slug: z.string().min(2).max(32),
	name: z.string().min(1).max(120),
	transport: z.enum(['stdio', 'http']),
	command: z.string().min(1).optional(),
	args: z.array(z.string()).optional(),
	cwd: z.string().optional(),
	url: z.string().url().optional(),
	authStyle: z.enum(['bearer', 'header', 'none']).optional(),
	authName: z.string().min(1).max(80).optional(),
	authRef: z.string().min(1).max(120).optional(),
	headersRef: z.string().min(1).max(120).optional(),
	env: z.record(z.string(), z.string()).default({}),
	timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
	pin: z.enum(['pinned', 'lazy']).optional(),
	enabled: z.boolean().optional()
});

const profileSchema = z.object({
	name: z.string().min(1).max(120),
	rateLimitRpm: z.number().int().min(1).max(100_000).optional(),
	dailyCallQuota: z.number().int().min(0).max(10_000_000).optional(),
	maxConcurrency: z.number().int().min(1).max(1_000).optional(),
	defaultTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
	upstreams: z
		.array(
			z.object({
				slug: z.string().min(2).max(32),
				allow: z.array(z.string()).optional(),
				deny: z.array(z.string()).optional()
			})
		)
		.default([])
});

export const manifestSchema = z.object({
	version: z.literal(1).default(1),
	upstreams: z.array(upstreamSchema).default([]),
	profiles: z.array(profileSchema).default([])
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestUpstream = Manifest['upstreams'][number];

export class ManifestError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`invalid manifest:\n  - ${issues.join('\n  - ')}`);
		this.name = 'ManifestError';
		this.issues = issues;
	}
}

/** A reference is `${ENV}` or `secret:<name>`; anything else may be a real value. */
export function isReference(value: string): boolean {
	return (
		/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) || /^secret:[a-z0-9][a-z0-9_-]{1,63}$/i.test(value)
	);
}

/**
 * Reject inlined credentials before anything is written.
 *
 * Deliberately conservative: an *unparseable* value is not what worries us here,
 * a *plausible* credential is — so a non-reference value is checked against the
 * token shapes from the redactor, and a match is a hard error naming the field.
 */
export function findInlinedSecrets(manifest: Manifest): string[] {
	const problems: string[] = [];
	for (const upstream of manifest.upstreams) {
		for (const [name, value] of Object.entries(upstream.env)) {
			if (isReference(value)) continue;
			const hits = findSecretLike(value);
			if (hits.length > 0) {
				problems.push(
					`upstream "${upstream.slug}" env ${name} looks like a real credential (${hits.join(', ')}) — use \${ENV_VAR} or secret:<name>`
				);
			}
		}
		for (const [field, value] of [
			['authRef', upstream.authRef],
			['headersRef', upstream.headersRef]
		] as const) {
			if (value && !isReference(value) && findSecretLike(value).length > 0) {
				problems.push(
					`upstream "${upstream.slug}" ${field} looks like a real credential — store it as a secret and reference it`
				);
			}
		}
	}
	return problems;
}

export function parseManifest(text: string): Manifest {
	let raw: unknown;
	try {
		raw = yaml.parse(text);
	} catch (error) {
		throw new ManifestError([`YAML could not be parsed: ${(error as Error).message}`]);
	}
	const parsed = manifestSchema.safeParse(raw);
	if (!parsed.success) {
		throw new ManifestError(
			parsed.error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`)
		);
	}

	const slugs = parsed.data.upstreams.map((upstream) => upstream.slug);
	const duplicates = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
	const issues: string[] = [];
	if (duplicates.length > 0) issues.push(`duplicate slugs: ${[...new Set(duplicates)].join(', ')}`);
	for (const upstream of parsed.data.upstreams) {
		try {
			assertValidSlug(upstream.slug);
		} catch (error) {
			issues.push((error as Error).message);
		}
		if (upstream.transport === 'stdio' && !upstream.command) {
			issues.push(`upstream "${upstream.slug}" is transport stdio and needs a command`);
		}
		if (upstream.transport === 'http' && !upstream.url) {
			issues.push(`upstream "${upstream.slug}" is transport http and needs a url`);
		}
	}
	for (const profile of parsed.data.profiles) {
		for (const link of profile.upstreams) {
			if (!slugs.includes(link.slug))
				issues.push(`profile "${profile.name}" references unknown upstream "${link.slug}"`);
		}
	}
	if (issues.length > 0) throw new ManifestError(issues);

	const secrets = findInlinedSecrets(parsed.data);
	if (secrets.length > 0) throw new ManifestError(secrets);

	return parsed.data;
}

/** Serialise the current configuration. Secret values are never included. */
export function renderManifest(db: Db = getDb()): string {
	const snapshot = getSnapshot();
	const upstreamRows = db.select().from(upstreams).all();
	const profileRows = db.select().from(profiles).all();

	const manifest: Manifest = {
		version: 1,
		upstreams: upstreamRows.map((row) => {
			const connection = (row.connection ?? {}) as Record<string, unknown>;
			return {
				slug: row.slug,
				name: row.name,
				transport: row.transport,
				...(typeof connection.command === 'string' ? { command: connection.command } : {}),
				...(Array.isArray(connection.args) ? { args: connection.args as string[] } : {}),
				...(typeof connection.cwd === 'string' ? { cwd: connection.cwd } : {}),
				...(typeof connection.url === 'string' ? { url: connection.url } : {}),
				...(typeof connection.authStyle === 'string'
					? { authStyle: connection.authStyle as ManifestUpstream['authStyle'] }
					: {}),
				...(typeof connection.authName === 'string' ? { authName: connection.authName } : {}),
				...(typeof connection.authRef === 'string' ? { authRef: connection.authRef } : {}),
				...(row.headersRef ? { headersRef: row.headersRef } : {}),
				env: { ...(row.envRefs ?? {}) },
				timeoutMs: row.timeoutMs,
				pin: row.pin,
				enabled: row.enabled
			};
		}),
		profiles: profileRows.map((profile) => {
			const cached = snapshot.profilesById.get(profile.id);
			return {
				name: profile.name,
				rateLimitRpm: profile.rateLimitRpm,
				dailyCallQuota: profile.dailyCallQuota,
				maxConcurrency: profile.maxConcurrency,
				defaultTimeoutMs: profile.defaultTimeoutMs,
				upstreams: (cached?.links ?? []).map((link) => ({
					slug: link.upstream.slug,
					allow: link.allowGlobs,
					deny: link.denyGlobs
				}))
			};
		})
	};

	return `# mcp-gateway configuration\n# Secret values are never written here: use \${ENV_VAR} or secret:<name>.\n${yaml.stringify(manifest)}`;
}

export type ManifestDiff = {
	added: string[];
	updated: string[];
	removed: string[];
	unchanged: string[];
	profilesAdded: string[];
	profilesUpdated: string[];
};

/** Compare a manifest against what is stored, without writing anything. */
export function diffManifest(manifest: Manifest, db: Db = getDb()): ManifestDiff {
	const existing = new Map(
		db
			.select()
			.from(upstreams)
			.all()
			.map((row) => [row.slug, row])
	);
	const existingProfiles = new Map(
		db
			.select()
			.from(profiles)
			.all()
			.map((row) => [row.name, row])
	);
	const incoming = new Set(manifest.upstreams.map((upstream) => upstream.slug));

	const added: string[] = [];
	const updated: string[] = [];
	const unchanged: string[] = [];
	for (const upstream of manifest.upstreams) {
		const row = existing.get(upstream.slug);
		if (!row) {
			added.push(upstream.slug);
			continue;
		}
		if (upstreamChanged(row, upstream)) updated.push(upstream.slug);
		else unchanged.push(upstream.slug);
	}
	const removed = [...existing.keys()].filter((slug) => !incoming.has(slug));

	const profilesAdded = manifest.profiles
		.filter((profile) => !existingProfiles.has(profile.name))
		.map((profile) => profile.name);
	const profilesUpdated = manifest.profiles
		.filter((profile) => {
			const row = existingProfiles.get(profile.name);
			if (!row) return false;
			return (
				row.rateLimitRpm !== (profile.rateLimitRpm ?? 120) ||
				row.dailyCallQuota !== (profile.dailyCallQuota ?? 1_000) ||
				row.maxConcurrency !== (profile.maxConcurrency ?? 10)
			);
		})
		.map((profile) => profile.name);

	return { added, updated, removed, unchanged, profilesAdded, profilesUpdated };
}

function upstreamChanged(row: typeof upstreams.$inferSelect, upstream: ManifestUpstream): boolean {
	const connection = (row.connection ?? {}) as Record<string, unknown>;
	if (row.transport !== upstream.transport) return true;
	if (upstream.transport === 'stdio') {
		if (connection.command !== upstream.command) return true;
		if (JSON.stringify(connection.args ?? []) !== JSON.stringify(upstream.args ?? [])) return true;
		if ((connection.cwd ?? '') !== (upstream.cwd ?? '')) return true;
	} else {
		if (connection.url !== upstream.url) return true;
		if ((connection.authStyle ?? 'none') !== (upstream.authStyle ?? 'none')) return true;
		if ((connection.authName ?? '') !== (upstream.authName ?? '')) return true;
		if ((connection.authRef ?? '') !== (upstream.authRef ?? '')) return true;
	}
	if ((row.headersRef ?? '') !== (upstream.headersRef ?? '')) return true;
	if (JSON.stringify(row.envRefs ?? {}) !== JSON.stringify(normaliseEnv(upstream.env))) return true;
	if (row.timeoutMs !== (upstream.timeoutMs ?? 60_000)) return true;
	if (row.pin !== (upstream.pin ?? 'pinned')) return true;
	if (row.enabled !== (upstream.enabled ?? true)) return true;
	return false;
}

/**
 * The manifest form and the stored form are identical by design (`${VAR}` for a
 * host variable, `secret:<name>` for a vault entry), so an export → import round
 * trip must produce byte-identical references — anything else shows up as a
 * phantom "updated" diff on every CI run.
 */
function normaliseEnv(env: Record<string, string>): Record<string, string> {
	return { ...env };
}

/** Host variable name behind a `${VAR}` reference. */
function hostVarName(ref: string): string | undefined {
	const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(ref);
	return match?.[1];
}

export type ApplyResult = ManifestDiff & {
	unconfigured: Array<{ slug: string; missing: string[] }>;
};

/**
 * Apply a manifest. Idempotent: an identical file writes nothing at all.
 * Upstreams missing from the file are disabled rather than deleted.
 */
export function applyManifest(
	manifest: Manifest,
	options: { actorId?: string | null; ip?: string | null; requestId?: string | null; db?: Db } = {}
): ApplyResult {
	const db = options.db ?? getDb();
	const diff = diffManifest(manifest, db);
	const unchanged =
		diff.added.length +
			diff.updated.length +
			diff.removed.length +
			diff.profilesAdded.length +
			diff.profilesUpdated.length ===
		0;

	if (!unchanged) {
		db.transaction((tx) => {
			for (const upstream of manifest.upstreams) {
				const envRefs = normaliseEnv(upstream.env);
				const connection =
					upstream.transport === 'stdio'
						? {
								command: upstream.command,
								args: upstream.args ?? [],
								...(upstream.cwd ? { cwd: upstream.cwd } : {})
							}
						: {
								url: upstream.url,
								authStyle: upstream.authStyle ?? 'none',
								...(upstream.authName ? { authName: upstream.authName } : {}),
								...(upstream.authRef ? { authRef: upstream.authRef } : {})
							};
				const existing = tx.select().from(upstreams).where(eq(upstreams.slug, upstream.slug)).get();
				if (existing) {
					tx.update(upstreams)
						.set({
							name: upstream.name,
							transport: upstream.transport,
							connection,
							envRefs,
							headersRef: upstream.headersRef ?? null,
							timeoutMs: upstream.timeoutMs ?? 60_000,
							pin: upstream.pin ?? 'pinned',
							enabled: upstream.enabled ?? true,
							updatedAt: nowIso()
						} as never)
						.where(eq(upstreams.id, existing.id))
						.run();
				} else {
					tx.insert(upstreams)
						.values({
							id: uuidv7(),
							slug: upstream.slug,
							name: upstream.name,
							transport: upstream.transport,
							enabled: upstream.enabled ?? true,
							connection,
							envRefs,
							headersRef: upstream.headersRef ?? null,
							timeoutMs: upstream.timeoutMs ?? 60_000,
							pin: upstream.pin ?? 'pinned',
							createdAt: nowIso(),
							updatedAt: nowIso()
						})
						.run();
				}
			}

			// missing from the file → disabled, recoverable, and visible as such
			if (diff.removed.length > 0) {
				const rows = tx
					.select()
					.from(upstreams)
					.all()
					.filter((row) => diff.removed.includes(row.slug));
				for (const row of rows) {
					tx.update(upstreams)
						.set({ enabled: false, updatedAt: nowIso() })
						.where(eq(upstreams.id, row.id))
						.run();
				}
			}

			for (const profile of manifest.profiles) {
				const links = profile.upstreams
					.map((link) => ({
						upstream: tx.select().from(upstreams).where(eq(upstreams.slug, link.slug)).get(),
						allow: link.allow,
						deny: link.deny
					}))
					.filter((entry) => entry.upstream !== undefined);
				const values = {
					rateLimitRpm: profile.rateLimitRpm ?? 120,
					dailyCallQuota: profile.dailyCallQuota ?? 1_000,
					maxConcurrency: profile.maxConcurrency ?? 10,
					defaultTimeoutMs: profile.defaultTimeoutMs ?? 60_000
				};
				const existing = tx.select().from(profiles).where(eq(profiles.name, profile.name)).get();
				const profileId = existing?.id ?? uuidv7();
				if (existing) {
					tx.update(profiles)
						.set({ ...values, updatedAt: nowIso() })
						.where(eq(profiles.id, existing.id))
						.run();
					tx.delete(profileUpstreams).where(eq(profileUpstreams.profileId, existing.id)).run();
				} else {
					tx.insert(profiles)
						.values({
							id: profileId,
							name: profile.name,
							...values,
							createdAt: nowIso(),
							updatedAt: nowIso()
						})
						.run();
				}
				for (const link of links) {
					tx.insert(profileUpstreams)
						.values({
							profileId,
							upstreamId: link.upstream!.id,
							allowGlobs: link.allow ?? ['*'],
							denyGlobs: link.deny ?? []
						})
						.run();
				}
			}
		});

		reload(db);
		// caches must drop every touched upstream, and disabled ones must close
		for (const slug of new Set([...diff.added, ...diff.updated, ...diff.removed])) {
			events.emit('upstream.changed', { slug, enabled: !diff.removed.includes(slug) });
		}
		recordAudit({
			actorType: 'user',
			actorId: options.actorId ?? null,
			action: 'manifest.apply',
			targetType: 'manifest',
			ip: options.ip ?? null,
			requestId: options.requestId ?? null,
			meta: {
				added: diff.added.length,
				updated: diff.updated.length,
				disabled: diff.removed.length,
				profilesAdded: diff.profilesAdded.length
			},
			db
		});
	}

	return { ...diff, unconfigured: findUnconfigured(manifest, db) };
}

/** Which imported upstreams cannot start because their env references are unset. */
function findUnconfigured(manifest: Manifest, db: Db): Array<{ slug: string; missing: string[] }> {
	const stored = new Map(
		db
			.select()
			.from(upstreams)
			.all()
			.map((row) => [row.slug, row])
	);
	const result: Array<{ slug: string; missing: string[] }> = [];
	for (const upstream of manifest.upstreams) {
		const row = stored.get(upstream.slug);
		if (!row) continue;
		const missing = Object.entries(row.envRefs ?? {})
			.filter(([, ref]) => {
				// vault references are checked by the vault at spawn time
				const variable = hostVarName(ref);
				if (!variable) return false;
				return process.env[variable] === undefined || process.env[variable] === '';
			})
			.map(([name]) => name);
		if (missing.length > 0) result.push({ slug: upstream.slug, missing });
	}
	return result;
}
