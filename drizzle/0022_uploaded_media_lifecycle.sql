CREATE TABLE `uploaded_media` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`media_type` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`attached_at` text,
	`claim_token` text,
	`claimed_at` text,
	CONSTRAINT "uploaded_media_status_check" CHECK("uploaded_media"."status" IN ('pending','attaching','attached','pruning'))
);
--> statement-breakpoint
CREATE INDEX `uploaded_media_owner_created_idx` ON `uploaded_media` (`owner_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `uploaded_media_status_created_idx` ON `uploaded_media` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `uploaded_media_references` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`media_key` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`media_key`) REFERENCES `uploaded_media`(`key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "uploaded_media_references_type_check" CHECK("uploaded_media_references"."resource_type" IN ('post','vendor','support','featured'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploaded_media_references_unique` ON `uploaded_media_references` (`media_key`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE INDEX `uploaded_media_references_resource_idx` ON `uploaded_media_references` (`resource_type`,`resource_id`);