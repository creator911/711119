CREATE TABLE `member_activity_stats` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`attendance_count` integer DEFAULT 0 NOT NULL,
	`post_count` integer DEFAULT 0 NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `outbox_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`available_at` text NOT NULL,
	`locked_at` text,
	`locked_by` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	CONSTRAINT "outbox_jobs_status_check" CHECK("outbox_jobs"."status" IN ('pending','processing','complete','failed'))
);
--> statement-breakpoint
CREATE INDEX `outbox_jobs_claim_idx` ON `outbox_jobs` (`status`,`available_at`,`id`);--> statement-breakpoint
CREATE INDEX `outbox_jobs_completed_idx` ON `outbox_jobs` (`completed_at`,`id`);--> statement-breakpoint
CREATE TABLE `post_stats` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `support_stats` (
	`inquiry_id` integer PRIMARY KEY NOT NULL,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`inquiry_id`) REFERENCES `support_inquiries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `member_activity_stats` (`user_id`,`attendance_count`,`post_count`,`comment_count`,`updated_at`)
SELECT u.`id`,COALESCE(a.`count`,0),COALESCE(p.`count`,0),COALESCE(c.`count`,0),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `users` u
LEFT JOIN (SELECT `user_id`,COUNT(*) AS `count` FROM `attendance` GROUP BY `user_id`) a ON a.`user_id`=u.`id`
LEFT JOIN (SELECT `author_id` AS `user_id`,COUNT(*) AS `count` FROM `posts` WHERE `status`='published' GROUP BY `author_id`) p ON p.`user_id`=u.`id`
LEFT JOIN (SELECT `user_id`,COUNT(*) AS `count` FROM `post_comments` WHERE `status`='published' GROUP BY `user_id`) c ON c.`user_id`=u.`id`;
--> statement-breakpoint
INSERT INTO `post_stats` (`post_id`,`comment_count`,`updated_at`)
SELECT p.`id`,COALESCE(c.`count`,0),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `posts` p
LEFT JOIN (SELECT `post_id`,COUNT(*) AS `count` FROM `post_comments` WHERE `status`='published' GROUP BY `post_id`) c ON c.`post_id`=p.`id`;
--> statement-breakpoint
INSERT INTO `support_stats` (`inquiry_id`,`reply_count`,`updated_at`)
SELECT i.`id`,COALESCE(r.`count`,0),strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `support_inquiries` i
LEFT JOIN (SELECT `inquiry_id`,COUNT(*) AS `count` FROM `support_inquiry_replies` GROUP BY `inquiry_id`) r ON r.`inquiry_id`=i.`id`;
--> statement-breakpoint
CREATE TRIGGER `member_activity_attendance_insert`
AFTER INSERT ON `attendance`
BEGIN
  INSERT INTO `member_activity_stats` (`user_id`,`attendance_count`,`post_count`,`comment_count`,`updated_at`)
  VALUES(NEW.`user_id`,1,0,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(`user_id`) DO UPDATE SET
    `attendance_count`=`attendance_count`+1,
    `updated_at`=excluded.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_attendance_delete`
AFTER DELETE ON `attendance`
BEGIN
  UPDATE `member_activity_stats`
  SET `attendance_count`=MAX(0,`attendance_count`-1),`updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE `user_id`=OLD.`user_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_post_insert`
AFTER INSERT ON `posts` WHEN NEW.`status`='published'
BEGIN
  INSERT INTO `member_activity_stats` (`user_id`,`attendance_count`,`post_count`,`comment_count`,`updated_at`)
  VALUES(NEW.`author_id`,0,1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(`user_id`) DO UPDATE SET
    `post_count`=`post_count`+1,
    `updated_at`=excluded.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_post_status`
AFTER UPDATE OF `status` ON `posts` WHEN OLD.`status`!=NEW.`status`
BEGIN
  INSERT INTO `member_activity_stats` (`user_id`,`attendance_count`,`post_count`,`comment_count`,`updated_at`)
  VALUES(NEW.`author_id`,0,CASE WHEN NEW.`status`='published' THEN 1 ELSE 0 END,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(`user_id`) DO UPDATE SET
    `post_count`=MAX(0,`post_count`+CASE WHEN NEW.`status`='published' THEN 1 WHEN OLD.`status`='published' THEN -1 ELSE 0 END),
    `updated_at`=excluded.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_post_delete`
AFTER DELETE ON `posts` WHEN OLD.`status`='published'
BEGIN
  UPDATE `member_activity_stats`
  SET `post_count`=MAX(0,`post_count`-1),`updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE `user_id`=OLD.`author_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_comment_insert`
AFTER INSERT ON `post_comments` WHEN NEW.`status`='published'
BEGIN
  INSERT INTO `member_activity_stats` (`user_id`,`attendance_count`,`post_count`,`comment_count`,`updated_at`)
  VALUES(NEW.`user_id`,0,0,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(`user_id`) DO UPDATE SET
    `comment_count`=`comment_count`+1,
    `updated_at`=excluded.`updated_at`;
  INSERT INTO `post_stats` (`post_id`,`comment_count`,`updated_at`)
  VALUES(NEW.`post_id`,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(`post_id`) DO UPDATE SET
    `comment_count`=`comment_count`+1,
    `updated_at`=excluded.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_comment_status`
AFTER UPDATE OF `status` ON `post_comments` WHEN OLD.`status`!=NEW.`status`
BEGIN
  INSERT INTO `member_activity_stats` (`user_id`,`attendance_count`,`post_count`,`comment_count`,`updated_at`)
  VALUES(NEW.`user_id`,0,0,CASE WHEN NEW.`status`='published' THEN 1 ELSE 0 END,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(`user_id`) DO UPDATE SET
    `comment_count`=MAX(0,`comment_count`+CASE WHEN NEW.`status`='published' THEN 1 WHEN OLD.`status`='published' THEN -1 ELSE 0 END),
    `updated_at`=excluded.`updated_at`;
  INSERT INTO `post_stats` (`post_id`,`comment_count`,`updated_at`)
  VALUES(NEW.`post_id`,CASE WHEN NEW.`status`='published' THEN 1 ELSE 0 END,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(`post_id`) DO UPDATE SET
    `comment_count`=MAX(0,`comment_count`+CASE WHEN NEW.`status`='published' THEN 1 WHEN OLD.`status`='published' THEN -1 ELSE 0 END),
    `updated_at`=excluded.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `member_activity_comment_delete`
AFTER DELETE ON `post_comments` WHEN OLD.`status`='published'
BEGIN
  UPDATE `member_activity_stats`
  SET `comment_count`=MAX(0,`comment_count`-1),`updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE `user_id`=OLD.`user_id`;
  UPDATE `post_stats`
  SET `comment_count`=MAX(0,`comment_count`-1),`updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE `post_id`=OLD.`post_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `support_stats_reply_insert`
AFTER INSERT ON `support_inquiry_replies`
BEGIN
  INSERT INTO `support_stats` (`inquiry_id`,`reply_count`,`updated_at`)
  VALUES(NEW.`inquiry_id`,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(`inquiry_id`) DO UPDATE SET
    `reply_count`=`reply_count`+1,
    `updated_at`=excluded.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `support_stats_reply_delete`
AFTER DELETE ON `support_inquiry_replies`
BEGIN
  UPDATE `support_stats`
  SET `reply_count`=MAX(0,`reply_count`-1),`updated_at`=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE `inquiry_id`=OLD.`inquiry_id`;
END;
