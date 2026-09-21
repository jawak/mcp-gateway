/**
 * Database schema (T-04) — mirrors ".agents/2-TECH-SPEC.md → BAGIAN 2".
 *
 * Conventions:
 *  - ids are UUIDv7 TEXT (`shared/ids.ts`): time-sortable, safe across replicas.
 *  - timestamps are ISO-8601 UTC TEXT; Drizzle maps them to `Date` via
 *    `mode: 'string'` at the driver level being unsuitable, so we store strings
 *    explicitly and convert at the boundary (`shared/time.ts`).
 *  - config blobs (connection, env refs, caps, globs) are JSON columns, not EAV.
 *  - `audit_log` is append-only by policy: no update/delete helpers exist.
 */
import { sql } from 'drizzle-orm';
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
	type SQLiteColumn
} from 'drizzle-orm/sqlite-core';

const now = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const users = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull(),
		passwordHash: text('password_hash').notNull(),
		role: text('role', { enum: ['admin', 'viewer'] }).notNull(),
		status: text('status', { enum: ['active', 'disabled'] })
			.notNull()
			.default('active'),
		failedAttempts: integer('failed_attempts').notNull().default(0),
		lockedUntil: text('locked_until'),
		createdAt: text('created_at').notNull().default(now()),
		updatedAt: text('updated_at').notNull().default(now())
	},
	(t) => [uniqueIndex('users_email_idx').on(t.email)]
);

export const webSessions = sqliteTable(
	'web_sessions',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		ip: text('ip'),
		userAgent: text('user_agent'),
		createdAt: text('created_at').notNull().default(now()),
		expiresAt: text('expires_at').notNull(),
		revokedAt: text('revoked_at')
	},
	(t) => [
		index('web_sessions_user_idx').on(t.userId),
		index('web_sessions_expiry_idx').on(t.expiresAt)
	]
);

/**
 * An upstream MCP server. `connection` holds transport-specific, non-secret
 * fields: stdio → { command, args, cwd }, remote → { url, authStyle, authName }.
 * Secrets are only ever referenced by name through `env_refs` / `headers_ref`.
 */
export const upstreams = sqliteTable(
	'upstreams',
	{
		id: text('id').primaryKey(),
		slug: text('slug').notNull(),
		name: text('name').notNull(),
		transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		connection: text('connection', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
		envRefs: text('env_refs', { mode: 'json' })
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		headersRef: text('headers_ref'),
		timeoutMs: integer('timeout_ms').notNull().default(60_000),
		pin: text('pin', { enum: ['pinned', 'lazy'] })
			.notNull()
			.default('pinned'),
		caps: text('caps', { mode: 'json' }).$type<Record<string, unknown> | null>(),
		toolsCount: integer('tools_count').notNull().default(0),
		status: text('status', { mode: 'json' }).$type<Record<string, unknown> | null>(),
		lastError: text('last_error'),
		createdAt: text('created_at').notNull().default(now()),
		updatedAt: text('updated_at').notNull().default(now())
	},
	(t) => [uniqueIndex('upstreams_slug_idx').on(t.slug)]
);

/** Sealed secret material (AES-256-GCM); plaintext never lands in the database. */
export const secretRefs = sqliteTable(
	'secret_refs',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		cipher: text('cipher').notNull(),
		iv: text('iv').notNull(),
		tag: text('tag').notNull(),
		keyVer: integer('key_ver').notNull().default(1),
		createdAt: text('created_at').notNull().default(now()),
		rotatedAt: text('rotated_at')
	},
	(t) => [uniqueIndex('secret_refs_name_idx').on(t.name)]
);

export const upstreamHealth = sqliteTable(
	'upstream_health',
	{
		id: text('id').primaryKey(),
		upstreamId: text('upstream_id')
			.notNull()
			.references(() => upstreams.id, { onDelete: 'cascade' }),
		status: text('status', { enum: ['healthy', 'degraded', 'down', 'unconfigured'] }).notNull(),
		latencyMs: integer('latency_ms'),
		ok: integer('ok', { mode: 'boolean' }).notNull(),
		error: text('error'),
		checkedAt: text('checked_at').notNull().default(now())
	},
	(t) => [index('upstream_health_recent_idx').on(t.upstreamId, t.checkedAt)]
);

export const profiles = sqliteTable(
	'profiles',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		rateLimitRpm: integer('rate_limit_rpm').notNull().default(120),
		dailyCallQuota: integer('daily_call_quota').notNull().default(1000),
		maxConcurrency: integer('max_concurrency').notNull().default(10),
		defaultTimeoutMs: integer('default_timeout_ms').notNull().default(60_000),
		createdAt: text('created_at').notNull().default(now()),
		updatedAt: text('updated_at').notNull().default(now())
	},
	(t) => [uniqueIndex('profiles_name_idx').on(t.name)]
);

export const profileUpstreams = sqliteTable(
	'profile_upstreams',
	{
		profileId: text('profile_id')
			.notNull()
			.references(() => profiles.id, { onDelete: 'cascade' }),
		upstreamId: text('upstream_id')
			.notNull()
			.references(() => upstreams.id, { onDelete: 'cascade' }),
		allowGlobs: text('allow_globs', { mode: 'json' }).$type<string[]>().notNull().default(['*']),
		denyGlobs: text('deny_globs', { mode: 'json' }).$type<string[]>().notNull().default([])
	},
	(t) => [
		// a profile references an upstream at most once (allow/deny globs live here)
		primaryKey({ columns: [t.profileId, t.upstreamId], name: 'profile_upstreams_pk' }),
		index('profile_upstreams_upstream_idx').on(t.upstreamId)
	]
);

/**
 * MCP client credentials. Only the SHA-256 hash is stored; `keyPrefix`
 * (`mcpgw_` + 5 chars) and `keyTail4` exist so the UI can show something
 * recognisable without ever being able to recover the key.
 */
export const apiKeys = sqliteTable(
	'api_keys',
	{
		id: text('id').primaryKey(),
		keyHash: text('key_hash').notNull(),
		keyPrefix: text('key_prefix').notNull(),
		keyTail4: text('key_tail4').notNull(),
		name: text('name').notNull(),
		profileId: text('profile_id')
			.notNull()
			.references(() => profiles.id),
		status: text('status', { enum: ['active', 'suspended', 'revoked'] })
			.notNull()
			.default('active'),
		ipAllowlist: text('ip_allowlist', { mode: 'json' }).$type<string[] | null>(),
		expiresAt: text('expires_at'),
		lastUsedAt: text('last_used_at'),
		createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: text('created_at').notNull().default(now()),
		// self-reference: a rotated key points at the key it replaced
		rotatedFromId: text('rotated_from_id').references((): SQLiteColumn => apiKeys.id, {
			onDelete: 'set null'
		}),
		revokedAt: text('revoked_at')
	},
	(t) => [
		uniqueIndex('api_keys_hash_idx').on(t.keyHash),
		index('api_keys_profile_idx').on(t.profileId),
		index('api_keys_status_idx').on(t.status, t.expiresAt)
	]
);

export const mcpSessions = sqliteTable(
	'mcp_sessions',
	{
		id: text('id').primaryKey(),
		apiKeyId: text('api_key_id')
			.notNull()
			.references(() => apiKeys.id, { onDelete: 'cascade' }),
		profileId: text('profile_id')
			.notNull()
			.references(() => profiles.id),
		protocolVersion: text('protocol_version'),
		clientInfo: text('client_info', { mode: 'json' }).$type<Record<string, unknown> | null>(),
		createdAt: text('created_at').notNull().default(now()),
		lastSeenAt: text('last_seen_at').notNull().default(now()),
		closedAt: text('closed_at')
	},
	(t) => [
		index('mcp_sessions_key_idx').on(t.apiKeyId),
		index('mcp_sessions_seen_idx').on(t.lastSeenAt)
	]
);

export const toolCalls = sqliteTable(
	'tool_calls',
	{
		id: text('id').primaryKey(),
		requestId: text('request_id').notNull(),
		apiKeyId: text('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
		upstreamId: text('upstream_id').references(() => upstreams.id, { onDelete: 'set null' }),
		tool: text('tool').notNull(),
		upstreamTool: text('upstream_tool'),
		status: text('status', {
			enum: ['ok', 'error', 'timeout', 'rejected', 'rate_limited']
		}).notNull(),
		durationMs: integer('duration_ms').notNull(),
		reqBytes: integer('req_bytes'),
		resBytes: integer('res_bytes'),
		error: text('error'),
		debug: text('debug', { mode: 'json' }).$type<Record<string, unknown> | null>(),
		calledAt: text('called_at').notNull().default(now())
	},
	(t) => [
		index('tool_calls_time_idx').on(t.calledAt),
		index('tool_calls_key_time_idx').on(t.apiKeyId, t.calledAt),
		index('tool_calls_upstream_time_idx').on(t.upstreamId, t.calledAt),
		index('tool_calls_status_time_idx').on(t.status, t.calledAt),
		index('tool_calls_request_idx').on(t.requestId)
	]
);

/** Dashboard aggregate, rolled up from tool_calls by the worker (time-first PK). */
export const usageHourly = sqliteTable(
	'usage_hourly',
	{
		bucketHour: text('bucket_hour').notNull(),
		apiKeyId: text('api_key_id').notNull(),
		upstreamId: text('upstream_id').notNull(),
		tool: text('tool').notNull(),
		calls: integer('calls').notNull().default(0),
		errors: integer('errors').notNull().default(0),
		p50Ms: integer('p50_ms'),
		p95Ms: integer('p95_ms')
	},
	(t) => [
		primaryKey({
			columns: [t.bucketHour, t.apiKeyId, t.upstreamId, t.tool],
			name: 'usage_hourly_pk'
		})
	]
);

/** Append-only: mutations of this table are never exposed through the API. */
export const auditLog = sqliteTable(
	'audit_log',
	{
		id: text('id').primaryKey(),
		actorType: text('actor_type', { enum: ['user', 'api_key', 'system'] }).notNull(),
		actorId: text('actor_id'),
		action: text('action').notNull(),
		targetType: text('target_type').notNull(),
		targetId: text('target_id'),
		ip: text('ip'),
		requestId: text('request_id'),
		meta: text('meta', { mode: 'json' }).$type<Record<string, unknown> | null>(),
		createdAt: text('created_at').notNull().default(now())
	},
	(t) => [
		index('audit_time_idx').on(t.createdAt),
		index('audit_actor_idx').on(t.actorId, t.createdAt),
		index('audit_target_idx').on(t.targetId)
	]
);

export const templatesApplied = sqliteTable('templates_applied', {
	templateId: text('template_id').notNull(),
	upstreamId: text('upstream_id')
		.notNull()
		.references(() => upstreams.id, { onDelete: 'cascade' }),
	appliedAt: text('applied_at').notNull().default(now()),
	appliedBy: text('applied_by').references(() => users.id, { onDelete: 'set null' })
});

/** Key/value meta: schema_version, quota_day, quota_used, last_backup_at. */
export const kv = sqliteTable('kv', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const schema = {
	users,
	webSessions,
	upstreams,
	secretRefs,
	upstreamHealth,
	profiles,
	profileUpstreams,
	apiKeys,
	mcpSessions,
	toolCalls,
	usageHourly,
	auditLog,
	templatesApplied,
	kv
};

export type DbSchema = typeof schema;
