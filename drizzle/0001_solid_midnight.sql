ALTER TABLE `attendance` ADD `greeting` text DEFAULT '오늘도 출장나라와 함께해요' NOT NULL;--> statement-breakpoint
ALTER TABLE `attendance` ADD `created_at` text DEFAULT '' NOT NULL;