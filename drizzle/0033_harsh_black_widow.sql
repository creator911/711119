ALTER TABLE `shop_products` ADD `min_level` integer DEFAULT 1 NOT NULL CONSTRAINT `shop_products_min_level_check` CHECK(`min_level` BETWEEN 1 AND 9);--> statement-breakpoint
DROP TRIGGER `shop_purchase_validate_before_insert`;--> statement-breakpoint
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
END;
