CREATE TABLE `post_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_reports_post_user_unique` ON `post_reports` (`post_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `post_recommendations` ADD `vote_type` text DEFAULT 'up' NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `dislikes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `report_count` integer DEFAULT 0 NOT NULL;