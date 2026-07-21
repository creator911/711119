CREATE TABLE `site_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text DEFAULT 'system' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `site_settings` (`key`,`value`,`updated_by`,`updated_at`)
VALUES ('main_domain','https://nara001.co.kr','system','2026-07-21T00:00:00.000Z');
