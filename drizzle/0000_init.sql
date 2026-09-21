CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_tail4` text NOT NULL,
	`name` text NOT NULL,
	`profile_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`ip_allowlist` text,
	`expires_at` text,
	`last_used_at` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`rotated_from_id` text,
	`revoked_at` text,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`rotated_from_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_profile_idx` ON `api_keys` (`profile_id`);--> statement-breakpoint
CREATE INDEX `api_keys_status_idx` ON `api_keys` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`ip` text,
	`request_id` text,
	`meta` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_time_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `audit_log` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_target_idx` ON `audit_log` (`target_id`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`protocol_version` text,
	`client_info` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_sessions_key_idx` ON `mcp_sessions` (`api_key_id`);--> statement-breakpoint
CREATE INDEX `mcp_sessions_seen_idx` ON `mcp_sessions` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `profile_upstreams` (
	`profile_id` text NOT NULL,
	`upstream_id` text NOT NULL,
	`allow_globs` text DEFAULT '["*"]' NOT NULL,
	`deny_globs` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`profile_id`, `upstream_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_upstreams_upstream_idx` ON `profile_upstreams` (`upstream_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rate_limit_rpm` integer DEFAULT 120 NOT NULL,
	`daily_call_quota` integer DEFAULT 1000 NOT NULL,
	`max_concurrency` integer DEFAULT 10 NOT NULL,
	`default_timeout_ms` integer DEFAULT 60000 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_name_idx` ON `profiles` (`name`);--> statement-breakpoint
CREATE TABLE `secret_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cipher` text NOT NULL,
	`iv` text NOT NULL,
	`tag` text NOT NULL,
	`key_ver` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`rotated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `secret_refs_name_idx` ON `secret_refs` (`name`);--> statement-breakpoint
CREATE TABLE `templates_applied` (
	`template_id` text NOT NULL,
	`upstream_id` text NOT NULL,
	`applied_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`applied_by` text,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`applied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`api_key_id` text,
	`upstream_id` text,
	`tool` text NOT NULL,
	`upstream_tool` text,
	`status` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`req_bytes` integer,
	`res_bytes` integer,
	`error` text,
	`debug` text,
	`called_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tool_calls_time_idx` ON `tool_calls` (`called_at`);--> statement-breakpoint
CREATE INDEX `tool_calls_key_time_idx` ON `tool_calls` (`api_key_id`,`called_at`);--> statement-breakpoint
CREATE INDEX `tool_calls_upstream_time_idx` ON `tool_calls` (`upstream_id`,`called_at`);--> statement-breakpoint
CREATE INDEX `tool_calls_status_time_idx` ON `tool_calls` (`status`,`called_at`);--> statement-breakpoint
CREATE INDEX `tool_calls_request_idx` ON `tool_calls` (`request_id`);--> statement-breakpoint
CREATE TABLE `upstream_health` (
	`id` text PRIMARY KEY NOT NULL,
	`upstream_id` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`ok` integer NOT NULL,
	`error` text,
	`checked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `upstream_health_recent_idx` ON `upstream_health` (`upstream_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `upstreams` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`connection` text NOT NULL,
	`env_refs` text DEFAULT '{}' NOT NULL,
	`headers_ref` text,
	`timeout_ms` integer DEFAULT 60000 NOT NULL,
	`pin` text DEFAULT 'pinned' NOT NULL,
	`caps` text,
	`tools_count` integer DEFAULT 0 NOT NULL,
	`status` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upstreams_slug_idx` ON `upstreams` (`slug`);--> statement-breakpoint
CREATE TABLE `usage_hourly` (
	`bucket_hour` text NOT NULL,
	`api_key_id` text NOT NULL,
	`upstream_id` text NOT NULL,
	`tool` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`p50_ms` integer,
	`p95_ms` integer,
	PRIMARY KEY(`bucket_hour`, `api_key_id`, `upstream_id`, `tool`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `web_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `web_sessions_user_idx` ON `web_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `web_sessions_expiry_idx` ON `web_sessions` (`expires_at`);