CREATE TABLE `system_announcement_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`announcement_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`delivered_at` text NOT NULL,
	`acknowledged_at` text,
	FOREIGN KEY (`announcement_id`) REFERENCES `system_announcements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_announcement_receipts_announcement_user_unique` ON `system_announcement_receipts` (`announcement_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `system_announcement_receipts_user_ack_idx` ON `system_announcement_receipts` (`user_id`,`acknowledged_at`,`announcement_id`);--> statement-breakpoint
CREATE TABLE `system_announcements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content` text NOT NULL,
	`requires_confirmation` integer DEFAULT false NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "system_announcements_confirmation_check" CHECK("system_announcements"."requires_confirmation" IN (0,1)),
	CONSTRAINT "system_announcements_status_check" CHECK("system_announcements"."status" IN ('active','cancelled')),
	CONSTRAINT "system_announcements_window_check" CHECK("system_announcements"."starts_at" < "system_announcements"."ends_at")
);
--> statement-breakpoint
CREATE INDEX `system_announcements_active_window_idx` ON `system_announcements` (`status`,`starts_at`,`ends_at`,`id`);