CREATE TABLE `vendor_post_jump_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`jump_date` text NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_post_jump_usage_user_date_unique` ON `vendor_post_jump_usage` (`user_id`,`jump_date`);--> statement-breakpoint
CREATE INDEX `vendor_post_jump_usage_user_idx` ON `vendor_post_jump_usage` (`user_id`);--> statement-breakpoint
ALTER TABLE `vendor_posts` ADD `jumped_at` text;--> statement-breakpoint
CREATE INDEX `vendor_posts_jump_idx` ON `vendor_posts` (`status`,`jumped_at`,`id`);