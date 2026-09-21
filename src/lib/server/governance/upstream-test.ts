/**
 * Connection test for an upstream (used by the add form, the detail page and the
 * template installer).
 *
 * The point of a smoke test is that an operator learns *now*, with the real
 * error text, rather than when a model reports "tool unavailable". It therefore
 * reports the failure modes separately: configuration missing (env reference
 * unset), the process/endpoint refusing to start, and a handshake that produced
 * nothing useful.
 */
import { getUpstreamById } from '../registry/index.ts';
import { UpstreamPool } from '../upstream/pool.ts';
import { resolveEnvRefs, describeMissing } from '../security/env-resolve.ts';
import { qualify } from '../mcp/namespacing.ts';
import { openSecretByName } from './secrets.ts';
import { recordAudit } from '../observability/audit.ts';
import { getDb, type Db } from '../db/index.ts';
import { upstreams } from '../db/schema.ts';
import { nowIso } from '../../shared/time.ts';
import { eq } from 'drizzle-orm';

export type UpstreamTestResult = {
	ok: boolean;
	status: 'healthy' | 'degraded' | 'down' | 'unconfigured';
	tools?: number;
	resources?: number;
	prompts?: number;
	server?: string;
	latencyMs?: number;
	message?: string;
};

/**
 * Probe an upstream and report what it said.
 *
 * The connection is opened and closed by this call rather than taken from the
 * request pool. Two reasons: the dashboard runs inside the SvelteKit bundle, whose
 * pool is a *different* object from the entrypoint's, so borrowing from it would
 * silently create a second set of warm child processes; and a manual check should
 * measure a cold connect rather than inherit someone else's warmth.
 */
export async function testUpstream(
	slug: string,
	options: { actorId?: string | null; ip?: string | null; requestId?: string | null; db?: Db } = {}
): Promise<UpstreamTestResult> {
	const db = options.db ?? getDb();
	const record = getUpstreamById(slugById(db, slug));
	if (!record) return { ok: false, status: 'down', message: 'upstream not found' };

	// missing references first: spawning with an unset token produces a confusing
	// error from the child process instead of "you forgot to set SENTRY_TOKEN"
	const resolved = resolveEnvRefs(record.envRefs ?? {}, {
		readEnv: (name) => process.env[name],
		openSecret: openSecretByName
	});
	if (resolved.missing.length > 0) {
		persistStatus(db, record.id, 'unconfigured', resolved.missing.join('; '));
		return { ok: false, status: 'unconfigured', message: describeMissing(resolved.missing) };
	}

	const started = Date.now();
	const scratch = new UpstreamPool({ maxLive: 1 });
	try {
		const handle = await scratch.get({ ...record, enabled: true });
		const [tools, resources, prompts] = await Promise.all([
			handle.listTools({ timeoutMs: Math.min(record.timeoutMs, 20_000) }),
			handle.listResources().catch(() => ({ resources: [] })),
			handle.listPrompts().catch(() => ({ prompts: [] }))
		]);
		const latencyMs = Date.now() - started;
		await scratch.closeAll(1_000);
		persistStatus(db, record.id, 'healthy', null, {
			toolsCount: tools.tools.length,
			caps: handle.diagnostics().capabilities ?? null,
			// the qualified names, kept so the profile editor can preview a filter
			// against the names the gateway will really serve
			toolNames: tools.tools.map((tool) => qualify(record.slug, tool.name)),
			server: handle.diagnostics().serverInfo ?? null
		});
		// a connection that works but takes half the timeout deserves a warning:
		// that is where user-visible timeouts come from
		const status = latencyMs > record.timeoutMs / 2 ? 'degraded' : 'healthy';
		audit(options, record.slug, status, tools.tools.length);
		return {
			ok: true,
			status,
			tools: tools.tools.length,
			resources: resources.resources?.length ?? 0,
			prompts: prompts.prompts?.length ?? 0,
			server: handle.diagnostics().serverInfo?.name,
			latencyMs
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await scratch.closeAll(1_000).catch(() => undefined);
		persistStatus(db, record.id, 'down', message);
		audit(options, record.slug, 'down', 0);
		return { ok: false, status: 'down', message, latencyMs: Date.now() - started };
	}
}

function slugById(db: Db, slug: string): string {
	return (
		db.select({ id: upstreams.id }).from(upstreams).where(eq(upstreams.slug, slug)).get()?.id ?? ''
	);
}

function persistStatus(
	db: Db,
	id: string,
	status: UpstreamTestResult['status'],
	error: string | null,
	extra: {
		toolsCount?: number;
		caps?: Record<string, unknown> | null;
		toolNames?: string[];
		server?: { name: string; version?: string } | null;
	} = {}
): void {
	try {
		db.update(upstreams)
			.set({
				status: {
					state: status,
					checkedAt: nowIso(),
					...(error ? { error } : {}),
					...(extra.toolNames ? { toolNames: extra.toolNames } : {}),
					...(extra.server ? { server: extra.server } : {})
				},
				lastError: error,
				...(extra.toolsCount !== undefined ? { toolsCount: extra.toolsCount } : {}),
				...(extra.caps !== undefined ? { caps: extra.caps } : {}),
				...(extra.toolNames !== undefined ? { toolNames: extra.toolNames } : {}),
				updatedAt: nowIso()
			} as never)
			.where(eq(upstreams.id, id))
			.run();
	} catch {
		// status reporting must never break the operation that produced it
	}
}

function audit(
	options: { actorId?: string | null; ip?: string | null; requestId?: string | null },
	slug: string,
	status: UpstreamTestResult['status'],
	tools: number
): void {
	recordAudit({
		actorType: 'user',
		actorId: options.actorId ?? null,
		action: 'upstream.test',
		targetType: 'upstream',
		targetId: slug,
		ip: options.ip ?? null,
		requestId: options.requestId ?? null,
		meta: { status, tools }
	});
}
