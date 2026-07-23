CREATE TABLE `event_rollup_cleanup_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period_type` text NOT NULL,
	`period_start` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_rollup_cleanup_period_unique` ON `event_rollup_cleanup_queue` (`period_type`,`period_start`);--> statement-breakpoint
CREATE INDEX `event_rollup_cleanup_created_idx` ON `event_rollup_cleanup_queue` (`created_at`,`id`);--> statement-breakpoint
INSERT OR IGNORE INTO `event_rollup_cleanup_queue` (`period_type`,`period_start`,`created_at`)
SELECT DISTINCT r.`period_type`,r.`period_start`,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `event_activity_rollups` r
WHERE EXISTS(
  SELECT 1 FROM `site_settings` s
  WHERE s.`key`='event_reward_settled:' || r.`period_type` || ':posts:' || r.`period_start`
    AND s.`value` LIKE 'complete:%'
)
AND EXISTS(
  SELECT 1 FROM `site_settings` s
  WHERE s.`key`='event_reward_settled:' || r.`period_type` || ':comments:' || r.`period_start`
    AND s.`value` LIKE 'complete:%'
);--> statement-breakpoint
CREATE TABLE `member_account_login_failures` (
	`username` text PRIMARY KEY NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`blocked_until` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `member_account_login_failures_updated_idx` ON `member_account_login_failures` (`updated_at`,`username`);--> statement-breakpoint
CREATE TABLE `member_ip_login_failures` (
	`ip` text PRIMARY KEY NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`blocked_until` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `member_ip_login_failures_updated_idx` ON `member_ip_login_failures` (`updated_at`,`ip`);--> statement-breakpoint
CREATE INDEX `admin_account_login_failures_updated_idx` ON `admin_account_login_failures` (`updated_at`,`username`);--> statement-breakpoint
CREATE INDEX `admin_ip_login_failures_updated_idx` ON `admin_ip_login_failures` (`updated_at`,`ip`);--> statement-breakpoint
CREATE INDEX `attendance_date_created_id_idx` ON `attendance` (`attendance_date`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `point_ledger_user_id_idx` ON `point_ledger` (`user_id`,`id`);--> statement-breakpoint
CREATE INDEX `posts_draft_created_id_idx` ON `posts` (`created_at`,`id`) WHERE `status`='draft';--> statement-breakpoint
CREATE INDEX `post_comments_pending_created_id_idx` ON `post_comments` (`created_at`,`id`) WHERE `status`='pending';--> statement-breakpoint
CREATE TEMP TABLE `_content_reward_duplicates_0043` AS
SELECT l.`id`,l.`user_id`,l.`amount`
FROM `point_ledger` l
WHERE l.`type` IN ('post_create','review_create','comment_create')
  AND l.`reference` IS NOT NULL
  AND l.`id` NOT IN(
    SELECT MIN(`id`) FROM `point_ledger`
    WHERE `type` IN ('post_create','review_create','comment_create')
      AND `reference` IS NOT NULL
    GROUP BY `user_id`,`type`,`reference`
  );--> statement-breakpoint
UPDATE `users`
SET `points`=`points`-COALESCE((
  SELECT SUM(d.`amount`) FROM `_content_reward_duplicates_0043` d WHERE d.`user_id`=`users`.`id`
),0)
WHERE `id` IN(SELECT DISTINCT `user_id` FROM `_content_reward_duplicates_0043`);--> statement-breakpoint
INSERT INTO `point_ledger` (`user_id`,`amount`,`type`,`status`,`reference`,`created_at`)
SELECT d.`user_id`,-d.`amount`,'content_reward_correction','complete','dedupe:' || CAST(d.`id` AS text),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `_content_reward_duplicates_0043` d;--> statement-breakpoint
UPDATE `point_ledger`
SET `type`='content_reward_duplicate'
WHERE `id` IN(SELECT `id` FROM `_content_reward_duplicates_0043`);--> statement-breakpoint
DROP TABLE `_content_reward_duplicates_0043`;--> statement-breakpoint
CREATE UNIQUE INDEX `point_ledger_content_reward_user_reference_unique` ON `point_ledger` (`user_id`,`type`,`reference`) WHERE "point_ledger"."type" IN ('post_create','review_create','comment_create') AND "point_ledger"."reference" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `post_comments_post_status_id_idx` ON `post_comments` (`post_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_token_idx` ON `sessions` (`expires_at`,`token`);--> statement-breakpoint
CREATE INDEX `system_announcements_ends_id_idx` ON `system_announcements` (`ends_at`,`id`);
