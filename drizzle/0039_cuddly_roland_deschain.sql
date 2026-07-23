CREATE TABLE `support_write_rate_limits` (
	`actor_key` text NOT NULL,
	`action` text NOT NULL,
	`window_start` integer NOT NULL,
	`request_count` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_write_rate_limits_bucket_unique` ON `support_write_rate_limits` (`actor_key`,`action`,`window_start`);--> statement-breakpoint
CREATE INDEX `support_write_rate_limits_window_idx` ON `support_write_rate_limits` (`window_start`);