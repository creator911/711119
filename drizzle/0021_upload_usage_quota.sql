CREATE TABLE `upload_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `upload_usage_actor_created_idx` ON `upload_usage` (`actor_key`,`created_at`);
