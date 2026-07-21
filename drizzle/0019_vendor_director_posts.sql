CREATE TABLE `director_regions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`region` text NOT NULL,
	`district` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `director_regions_user_region_district_unique` ON `director_regions` (`user_id`,`region`,`district`);
--> statement-breakpoint
CREATE INDEX `director_regions_user_idx` ON `director_regions` (`user_id`);
--> statement-breakpoint
CREATE TABLE `vendor_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`industry` text NOT NULL,
	`region` text NOT NULL,
	`district` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`author_id` integer NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_posts_author_region_district_unique` ON `vendor_posts` (`author_id`,`region`,`district`);
--> statement-breakpoint
CREATE INDEX `vendor_posts_filter_idx` ON `vendor_posts` (`industry`,`region`,`district`,`id`);
