PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER `shop_purchase_validate_before_insert`;--> statement-breakpoint
DROP TRIGGER `shop_purchase_apply_after_insert`;--> statement-breakpoint
CREATE TABLE `__new_shop_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price` integer NOT NULL,
	`stock` integer DEFAULT 0 NOT NULL,
	`min_level` integer DEFAULT 1 NOT NULL,
	`fallback_image` text DEFAULT '' NOT NULL,
	`cover_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "shop_products_price_check" CHECK("__new_shop_products"."price" >= 0),
	CONSTRAINT "shop_products_stock_check" CHECK("__new_shop_products"."stock" >= 0),
	CONSTRAINT "shop_products_min_level_check" CHECK("__new_shop_products"."min_level" BETWEEN 1 AND 9),
	CONSTRAINT "shop_products_status_check" CHECK("__new_shop_products"."status" IN ('active','hidden'))
);
--> statement-breakpoint
INSERT INTO `__new_shop_products`("id", "name", "description", "price", "stock", "min_level", "fallback_image", "cover_key", "status", "version", "created_at", "updated_at") SELECT "id", "name", "description", "price", "stock", 1, "fallback_image", "cover_key", "status", "version", "created_at", "updated_at" FROM `shop_products`;--> statement-breakpoint
DROP TABLE `shop_products`;--> statement-breakpoint
ALTER TABLE `__new_shop_products` RENAME TO `shop_products`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `shop_products_status_id_idx` ON `shop_products` (`status`,`id`);--> statement-breakpoint
CREATE TRIGGER `shop_purchase_validate_before_insert`
BEFORE INSERT ON `shop_purchases`
BEGIN
  SELECT CASE WHEN length(trim(NEW.request_key)) < 12 THEN RAISE(ABORT,'shop_request_invalid') END;
  SELECT CASE WHEN NEW.voucher_id IS NOT NULL OR NEW.support_inquiry_id IS NOT NULL
    THEN RAISE(ABORT,'shop_request_invalid') END;
  SELECT CASE WHEN NEW.status != 'pending_delivery' OR NEW.delivered_at IS NOT NULL
    THEN RAISE(ABORT,'shop_request_invalid') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM users WHERE id=NEW.user_id AND status='active'
  ) THEN RAISE(ABORT,'shop_member_unavailable') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM shop_products WHERE id=NEW.product_id AND status='active'
  ) THEN RAISE(ABORT,'shop_product_unavailable') END;
  SELECT CASE WHEN (SELECT level FROM users WHERE id=NEW.user_id) < (SELECT min_level FROM shop_products WHERE id=NEW.product_id)
    THEN RAISE(ABORT,'shop_level_insufficient') END;
  SELECT CASE WHEN NEW.price != (SELECT price FROM shop_products WHERE id=NEW.product_id)
    OR NEW.product_name != (SELECT name FROM shop_products WHERE id=NEW.product_id)
    THEN RAISE(ABORT,'shop_product_changed') END;
  SELECT CASE WHEN (SELECT points FROM users WHERE id=NEW.user_id) < NEW.price
    THEN RAISE(ABORT,'shop_points_insufficient') END;
  SELECT CASE WHEN (SELECT stock FROM shop_products WHERE id=NEW.product_id) < 1
    THEN RAISE(ABORT,'shop_stock_insufficient') END;
END;--> statement-breakpoint
CREATE TRIGGER `shop_purchase_apply_after_insert`
AFTER INSERT ON `shop_purchases`
BEGIN
  UPDATE users SET points=points-NEW.price WHERE id=NEW.user_id;
  UPDATE shop_products SET stock=stock-1,updated_at=NEW.created_at WHERE id=NEW.product_id;
  INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
  VALUES(NEW.user_id,-NEW.price,'shop_purchase','complete','shop-purchase:' || NEW.id,NEW.created_at);
  INSERT INTO support_inquiries(user_id,kind,title,body,status,staff_unread,member_unread,shop_purchase_id,created_at,updated_at)
  VALUES(NEW.user_id,'support','상품 구매 · ' || NEW.product_name,'<p><strong>상품 구매가 완료되었습니다.</strong></p><p>자동상품 지급을 준비하고 있습니다.</p>','open',0,0,NEW.id,NEW.created_at,NEW.created_at);
  UPDATE shop_purchases
  SET support_inquiry_id=(SELECT id FROM support_inquiries WHERE shop_purchase_id=NEW.id)
  WHERE id=NEW.id;
END;
