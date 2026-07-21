CREATE TABLE `event_reward_payouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period_type` text NOT NULL,
	`board_type` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`user_id` integer NOT NULL,
	`rank` integer NOT NULL,
	`activity_count` integer NOT NULL,
	`points` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_reward_payouts_period_user_unique` ON `event_reward_payouts` (`period_type`,`board_type`,`period_start`,`user_id`);
