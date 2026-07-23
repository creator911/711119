CREATE INDEX `attendance_date_user_idx` ON `attendance` (`attendance_date`,`user_id`);--> statement-breakpoint
CREATE INDEX `event_reward_payouts_period_rank_idx` ON `event_reward_payouts` (`period_type`,`board_type`,`period_start`,`rank`);--> statement-breakpoint
CREATE INDEX `event_reward_payouts_audit_idx` ON `event_reward_payouts` (`period_type`,`period_start`,`board_type`,`rank`);--> statement-breakpoint
CREATE UNIQUE INDEX `point_ledger_event_reward_user_reference_unique` ON `point_ledger` (`user_id`,`type`,`reference`) WHERE "point_ledger"."type" = 'event_reward' AND "point_ledger"."reference" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `post_comments_user_status_idx` ON `post_comments` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `post_comments_event_activity_idx` ON `post_comments` (`created_at`,`user_id`) WHERE "post_comments"."status" = 'published';--> statement-breakpoint
CREATE INDEX `posts_author_status_idx` ON `posts` (`author_id`,`status`);--> statement-breakpoint
CREATE INDEX `posts_event_activity_idx` ON `posts` (`created_at`,`author_id`) WHERE "posts"."status" = 'published' AND "posts"."category" IN ('reviews','gifs','community');
