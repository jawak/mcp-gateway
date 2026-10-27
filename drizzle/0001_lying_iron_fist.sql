CREATE TABLE `upstream_oauth` (
	`upstream_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`client_id` text,
	`client_secret_ref` text,
	`authorization_server_url` text,
	`resource_metadata_url` text,
	`authorization_endpoint` text,
	`token_endpoint` text,
	`registration_endpoint` text,
	`scopes` text,
	`discovery` text,
	`access_token_ref` text,
	`refresh_token_ref` text,
	`expires_at` text,
	`token_type` text,
	`granted_scope` text,
	`last_error` text,
	`connected_by` text,
	`connected_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `upstream_oauth_status_idx` ON `upstream_oauth` (`status`);--> statement-breakpoint
CREATE TABLE `upstream_oauth_pending` (
	`state` text PRIMARY KEY NOT NULL,
	`upstream_id` text NOT NULL,
	`verifier_sealed` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upstream_oauth_pending_upstream_idx` ON `upstream_oauth_pending` (`upstream_id`);