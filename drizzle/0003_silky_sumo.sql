CREATE TABLE `support_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` integer NOT NULL,
	`sender_type` text NOT NULL,
	`sender_id` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_rooms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`staff_unread` integer DEFAULT 0 NOT NULL,
	`member_unread` integer DEFAULT 0 NOT NULL,
	`last_message` text DEFAULT '' NOT NULL,
	`last_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_rooms_user_id_unique` ON `support_rooms` (`user_id`);