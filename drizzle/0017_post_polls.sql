CREATE TABLE `post_polls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`question` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_polls_post_unique` ON `post_polls` (`post_id`);
--> statement-breakpoint
CREATE TABLE `post_poll_options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poll_id` integer NOT NULL,
	`position` integer NOT NULL,
	`label` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_poll_options_poll_position_unique` ON `post_poll_options` (`poll_id`,`position`);
--> statement-breakpoint
CREATE TABLE `post_poll_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`poll_id` integer NOT NULL,
	`option_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_poll_votes_poll_user_unique` ON `post_poll_votes` (`poll_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `post_poll_votes_option_idx` ON `post_poll_votes` (`option_id`);
