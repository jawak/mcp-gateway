/**
 * Runtime settings (T-40).
 *
 * Two layers, deliberately:
 *  - **Deployment settings** (port, master key, public URL, token) come from the
 *    environment and are read-only here. They decide trust boundaries and the
 *    process must not be able to rewrite its own security posture at runtime —
 *    a compromised dashboard could otherwise disable auth.
 *  - **Operational overrides** (retention windows, payload debugging, health
 *    interval) live in `kv` so an operator can tune them without a redeploy. They
 *    never widen a security boundary, only how loudly or how long we keep things.
 */
import { eq } from 'drizzle-orm';
import { getDb, type Db } from './db/index.ts';
import { kv } from './db/schema.ts';
import { getConfig } from './config.ts';

export type Overrides = {
	healthIntervalS?: number;
	catalogTtlS?: number;
	sessionTtlMin?: number;
	retentionToolCallsDays?: number;
	retentionAuditDays?: number;
	retentionHealthDays?: number;
	retentionBackups?: number;
	debugPayload?: boolean;
};

const OVERRIDE_KEYS: Record<keyof Overrides, string> = {
	healthIntervalS: 'settings:health_interval_s',
	catalogTtlS: 'settings:catalog_ttl_s',
	sessionTtlMin: 'settings:session_ttl_min',
	retentionToolCallsDays: 'settings:retention_tool_calls_days',
	retentionAuditDays: 'settings:retention_audit_days',
	retentionHealthDays: 'settings:retention_health_days',
	retentionBackups: 'settings:retention_backups',
	debugPayload: 'settings:debug_payload'
};

export type EffectiveSettings = {
	healthIntervalS: number;
	catalogTtlS: number;
	sessionTtlMin: number;
	retentionToolCallsDays: number;
	retentionAuditDays: number;
	retentionHealthDays: number;
	retentionBackups: number;
	debugPayload: boolean;
};

/** Read-modify-write happens often enough (worker tick, dashboard load) to cache. */
let cached: { at: number; value: EffectiveSettings } | undefined;
const CACHE_MS = 5_000;

export function effectiveSettings(db: Db = getDb()): EffectiveSettings {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
	const config = getConfig();
	const stored = readOverrides(db);
	const value: EffectiveSettings = {
		healthIntervalS: stored.healthIntervalS ?? Math.round(config.healthIntervalMs / 1000),
		catalogTtlS: stored.catalogTtlS ?? Math.round(config.catalogTtlMs / 1000),
		sessionTtlMin: stored.sessionTtlMin ?? Math.round(config.sessionTtlMs / 60_000),
		retentionToolCallsDays: stored.retentionToolCallsDays ?? config.retention.toolCallsDays,
		retentionAuditDays: stored.retentionAuditDays ?? config.retention.auditDays,
		retentionHealthDays: stored.retentionHealthDays ?? config.retention.healthDays,
		retentionBackups: stored.retentionBackups ?? config.retention.backups,
		// either source can turn debugging on; both mean "store redacted payloads"
		debugPayload: stored.debugPayload ?? config.debugPayload
	};
	cached = { at: Date.now(), value };
	return value;
}

function readOverrides(db: Db): Overrides {
	const rows = db.select().from(kv).all();
	const byKey = new Map(rows.map((row) => [row.key, row.value]));
	const result: Overrides = {};
	for (const [field, key] of Object.entries(OVERRIDE_KEYS) as Array<[keyof Overrides, string]>) {
		const raw = byKey.get(key);
		if (raw === undefined) continue;
		if (field === 'debugPayload') {
			result.debugPayload = raw === 'true' || raw === '1';
			continue;
		}
		const numeric = Number.parseInt(raw, 10);
		if (Number.isFinite(numeric)) (result as Record<string, number>)[field] = numeric;
	}
	return result;
}

export function setOverrides(patch: Overrides, db: Db = getDb()): EffectiveSettings {
	for (const [field, key] of Object.entries(OVERRIDE_KEYS) as Array<[keyof Overrides, string]>) {
		const value = patch[field];
		if (value === undefined) continue;
		db.insert(kv)
			.values({ key, value: String(value) })
			.onConflictDoUpdate({ target: kv.key, set: { value: String(value) } })
			.run();
	}
	cached = undefined;
	return effectiveSettings(db);
}

export function clearOverride(field: keyof Overrides, db: Db = getDb()): EffectiveSettings {
	db.delete(kv).where(eq(kv.key, OVERRIDE_KEYS[field])).run();
	cached = undefined;
	return effectiveSettings(db);
}

/** Values that stay environment-only, shown read-only so nobody hunts for them. */
export function immutableSettings(): Array<{ label: string; value: string; hint: string }> {
	const config = getConfig();
	return [
		{ label: 'Public URL', value: config.origin, hint: 'Origin checks and client snippets' },
		{
			label: 'Bind address',
			value: `${config.host}:${config.port}`,
			hint: 'MCPGW_HOST / MCPGW_PORT'
		},
		{ label: 'Data directory', value: config.dataDir, hint: 'SQLite file and backups' },
		{
			label: 'Master key',
			value: config.masterKeyIsEphemeral
				? 'ephemeral (not persisted!)'
				: `set (${config.masterKeyVersion === 1 ? 'v1' : `v${config.masterKeyVersion}`})`,
			hint: 'MCPGW_MASTER_KEY — seals upstream secrets'
		},
		{
			label: 'Metrics token',
			value: process.env.MCPGW_METRICS_TOKEN ? 'set' : 'not set (scrape disabled)',
			hint: 'MCPGW_METRICS_TOKEN'
		},
		{
			label: 'Private network for upstreams',
			value: config.allowPrivateNetwork ? 'allowed' : 'blocked',
			hint: 'MCPGW_ALLOW_PRIVATE_NETWORK — SSRF policy'
		},
		{
			label: 'Trusted proxy',
			value: config.trustProxy ? 'one hop (X-Forwarded-For)' : 'direct',
			hint: 'MCPGW_TRUST_PROXY'
		}
	];
}

/** Test hook: drop the cache between cases. */
export function resetSettingsCache(): void {
	cached = undefined;
}
