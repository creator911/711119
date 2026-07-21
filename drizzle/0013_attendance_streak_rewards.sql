CREATE TABLE `attendance_streak_rewards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`milestone_days` integer NOT NULL,
	`points` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_streak_rewards_user_milestone_unique` ON `attendance_streak_rewards` (`user_id`,`milestone_days`);
