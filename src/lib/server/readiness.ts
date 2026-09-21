/**
 * Schema-readiness gate (T-44 plan, phase 4).
 *
 * A gateway whose database has not been migrated is a *expected* state — fresh
 * clone, new volume, someone deleted `data/` — and it must produce one clear,
 * actionable answer everywhere:
 *
 *   `/mcp`     → 503 `{ error: 'not_ready', hint: 'run `bun run db:migrate`' }`
 *   dashboard  → SvelteKit error page, status 503, same sentence
 *   `/healthz` → 200 with `ok: false, schema: 'no-schema'`, so a container
 *                healthcheck reports the problem without restart-looping a
 *                process that only needs one command from a human
 *
 * The probe is throttled because it sits on every request; the cached value is
 * also what stops a transient failure from being reported as "nothing configured".
 */
import { assertMigrated, MIGRATE_HINT, type MigrationsState } from './db/migrate.ts';
import { getDb } from './db/index.ts';
import { logger } from './observability/logger.ts';

const log = logger.child({ component: 'readiness' });
const CACHE_MS = 1_000;

let cached: { at: number; state: MigrationsState } | undefined;

export function migrationsState(force = false): MigrationsState {
	const now = Date.now();
	if (!force && cached && now - cached.at < CACHE_MS) return cached.state;
	let state: MigrationsState;
	try {
		state = assertMigrated(getDb());
	} catch (error) {
		// An unreadable database is not "unmigrated"; say so rather than sending the
		// operator to run a migration that will fail the same way.
		log.error({ err: error }, 'could not determine schema state');
		state = {
			ok: false,
			reason: 'no-database',
			version: 0,
			expected: 0,
			hint: 'check MCPGW_DATA_DIR and file permissions'
		};
	}
	cached = { at: now, state };
	return state;
}

export function isReady(): boolean {
	return migrationsState().ok;
}

/** Drop the cached verdict (after running migrations, or between tests). */
export function resetReadinessCache(): void {
	cached = undefined;
}

type NotReadyState = Extract<MigrationsState, { ok: false }>;

/**
 * Narrow the union. Callers here only ever run on the "not ready" path, but the
 * union does not know that — an explicit guard keeps the compiler honest and turns
 * a mis-wired call site into a loud error instead of `undefined` in a message.
 */
function asNotReady(state: MigrationsState): NotReadyState {
	if (!state.ok) return state;
	return {
		ok: false,
		reason: 'no-schema',
		version: 0,
		expected: 0,
		hint: MIGRATE_HINT
	};
}

export function notReadyBody(state: MigrationsState): Record<string, unknown> {
	const notReady = asNotReady(state);
	return {
		error: 'not_ready',
		reason: notReady.reason,
		hint: notReady.hint,
		message: `The gateway database is not ready (${notReady.reason}) — ${notReady.hint}.`
	};
}

/** `state` defaults to the cached probe so callers that have it can pass it through. */
export function notReadyResponse(state: MigrationsState = migrationsState()): Response {
	return new Response(JSON.stringify(notReadyBody(state)), {
		status: 503,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'retry-after': '5',
			'cache-control': 'no-store'
		}
	});
}

/**
 * Browser-facing variant for the dashboard.
 *
 * A returned Response rather than a thrown `error()`: the hook runs before routing,
 * so there is no route context to render an error page against, and a plain response
 * is the one thing guaranteed to reach the operator.
 */
export function notReadyHtmlResponse(): Response {
	const notReady = asNotReady(migrationsState());
	const message = escapeHtml(
		`The gateway database is not ready (${notReady.reason}) — ${notReady.hint}.`
	);
	return new Response(
		`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta http-equiv="refresh" content="5" />
		<title>mcp-gateway — database not ready</title>
		<style>
			body { margin: 0; min-height: 100dvh; display: grid; place-content: center; background: #fafafa; color: #18181b; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; padding: 2rem; }
			h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
			code { background: #e4e4e7; padding: .1rem .35rem; border-radius: .25rem; font-size: .9em; }
			p { max-width: 44rem; margin: .4rem 0; }
			@media (prefers-color-scheme: dark) { body { background: #09090b; color: #fafafa; } code { background: #27272a; } }
		</style>
	</head>
	<body>
		<h1>The gateway is running, but its database is not ready</h1>
		<p>${message}</p>
		<p>Reason: <code>${escapeHtml(notReady.reason)}</code> · schema ${notReady.version} of ${notReady.expected}.</p>
		<p>This page reloads itself every 5 seconds, so it recovers as soon as the migration runs.</p>
	</body>
</html>`,
		{
			status: 503,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'retry-after': '5',
				'cache-control': 'no-store'
			}
		}
	);
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}
