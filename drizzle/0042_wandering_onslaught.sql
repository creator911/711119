CREATE TABLE `shop_voucher_cleanup_queue` (
	`voucher_id` integer PRIMARY KEY NOT NULL,
	`product_id` integer NOT NULL,
	`object_key` text NOT NULL,
	`cleanup_token` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_voucher_cleanup_queue_object_key_unique` ON `shop_voucher_cleanup_queue` (`object_key`);--> statement-breakpoint
CREATE INDEX `shop_voucher_cleanup_product_id_idx` ON `shop_voucher_cleanup_queue` (`product_id`,`attempts`,`voucher_id`);--> statement-breakpoint
CREATE INDEX `shop_voucher_cleanup_token_idx` ON `shop_voucher_cleanup_queue` (`cleanup_token`);
