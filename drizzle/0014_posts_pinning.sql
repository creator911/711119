ALTER TABLE `posts` ADD COLUMN `is_pinned` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `posts_category_pinned_id_idx` ON `posts` (`category`,`is_pinned`,`id`);
