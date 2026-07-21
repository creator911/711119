CREATE TABLE `shop_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price` integer NOT NULL,
	`stock` integer DEFAULT 0 NOT NULL,
	`fallback_image` text DEFAULT '' NOT NULL,
	`cover_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "shop_products_price_check" CHECK("shop_products"."price" >= 0),
	CONSTRAINT "shop_products_stock_check" CHECK("shop_products"."stock" >= 0),
	CONSTRAINT "shop_products_status_check" CHECK("shop_products"."status" IN ('active','hidden'))
);
--> statement-breakpoint
CREATE INDEX `shop_products_status_id_idx` ON `shop_products` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `shop_purchases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_key` text NOT NULL,
	`product_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`product_name` text NOT NULL,
	`price` integer NOT NULL,
	`status` text DEFAULT 'pending_delivery' NOT NULL,
	`voucher_id` integer,
	`support_inquiry_id` integer,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shop_purchases_price_check" CHECK("shop_purchases"."price" >= 0),
	CONSTRAINT "shop_purchases_status_check" CHECK("shop_purchases"."status" IN ('pending_delivery','delivered'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_purchases_user_request_unique` ON `shop_purchases` (`user_id`,`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `shop_purchases_voucher_unique` ON `shop_purchases` (`voucher_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shop_purchases_support_unique` ON `shop_purchases` (`support_inquiry_id`);--> statement-breakpoint
CREATE INDEX `shop_purchases_product_status_id_idx` ON `shop_purchases` (`product_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `shop_purchases_user_id_idx` ON `shop_purchases` (`user_id`,`id`);--> statement-breakpoint
CREATE TABLE `shop_vouchers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`object_key` text NOT NULL,
	`original_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`purchase_id` integer,
	`created_at` text NOT NULL,
	`assigned_at` text,
	FOREIGN KEY (`product_id`) REFERENCES `shop_products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shop_vouchers_size_check" CHECK("shop_vouchers"."size_bytes" > 0),
	CONSTRAINT "shop_vouchers_status_check" CHECK("shop_vouchers"."status" IN ('available','reserved','delivered'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_vouchers_object_key_unique` ON `shop_vouchers` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `shop_vouchers_purchase_unique` ON `shop_vouchers` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `shop_vouchers_product_status_id_idx` ON `shop_vouchers` (`product_id`,`status`,`id`);--> statement-breakpoint
ALTER TABLE `support_inquiries` ADD `shop_purchase_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `support_inquiries_shop_purchase_unique` ON `support_inquiries` (`shop_purchase_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `shop_products` (`id`,`name`,`description`,`price`,`stock`,`fallback_image`,`status`,`version`,`created_at`,`updated_at`) VALUES
(1,'테스트 모바일 쿠폰','상점 이용 흐름을 확인할 수 있는 샘플 모바일 쿠폰입니다.',100,20,'/images/vendor-01.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z'),
(2,'카페 모바일 상품권','휴식 시간에 사용할 수 있는 샘플 모바일 상품권입니다.',5000,20,'/images/vendor-02.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z'),
(3,'편의점 모바일 상품권','가까운 매장에서 사용할 수 있는 샘플 모바일 상품권입니다.',5000,20,'/images/vendor-03.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z'),
(4,'문화 모바일 상품권','다양한 콘텐츠에 사용할 수 있는 샘플 상품권입니다.',10000,15,'/images/vendor-04.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z'),
(5,'배달 모바일 상품권','배달 주문에 사용할 수 있는 샘플 모바일 상품권입니다.',10000,15,'/images/vendor-05.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z'),
(6,'주유 모바일 쿠폰','주유 결제에 사용할 수 있는 샘플 모바일 쿠폰입니다.',10000,12,'/images/vendor-06.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z'),
(7,'영화 관람권','영화 관람에 사용할 수 있는 샘플 모바일 관람권입니다.',12000,12,'/images/vendor-07.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z'),
(8,'베이커리 모바일 상품권','베이커리 메뉴에 사용할 수 있는 샘플 상품권입니다.',10000,10,'/images/vendor-08.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z'),
(9,'아이스크림 교환권','아이스크림으로 교환할 수 있는 샘플 모바일 쿠폰입니다.',6000,10,'/images/vendor-09.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z'),
(10,'프리미엄 모바일 상품권','다양한 사용처를 위한 샘플 프리미엄 상품권입니다.',30000,8,'/images/vendor-10.jpg','active',1,'2026-07-21T00:00:00.000Z','2026-07-21T00:00:00.000Z');
--> statement-breakpoint
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
  SELECT CASE WHEN NEW.price != (SELECT price FROM shop_products WHERE id=NEW.product_id)
    OR NEW.product_name != (SELECT name FROM shop_products WHERE id=NEW.product_id)
    THEN RAISE(ABORT,'shop_product_changed') END;
  SELECT CASE WHEN (SELECT points FROM users WHERE id=NEW.user_id) < NEW.price
    THEN RAISE(ABORT,'shop_points_insufficient') END;
  SELECT CASE WHEN (SELECT stock FROM shop_products WHERE id=NEW.product_id) < 1
    THEN RAISE(ABORT,'shop_stock_insufficient') END;
END;
--> statement-breakpoint
CREATE TRIGGER `shop_voucher_purchase_validate_before_update`
BEFORE UPDATE OF `purchase_id`,`product_id`,`status` ON `shop_vouchers`
BEGIN
  SELECT CASE WHEN (NEW.status='available' AND NEW.purchase_id IS NOT NULL)
    OR (NEW.status IN ('reserved','delivered') AND NEW.purchase_id IS NULL)
    THEN RAISE(ABORT,'shop_voucher_state_invalid') END;
  SELECT CASE WHEN NEW.purchase_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM shop_purchases p
    WHERE p.id=NEW.purchase_id AND p.product_id=NEW.product_id
  ) THEN RAISE(ABORT,'shop_voucher_purchase_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER `shop_voucher_state_validate_before_insert`
BEFORE INSERT ON `shop_vouchers`
BEGIN
  SELECT CASE WHEN NEW.status != 'available' OR NEW.purchase_id IS NOT NULL
    THEN RAISE(ABORT,'shop_voucher_state_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER `shop_support_purchase_validate_before_insert`
BEFORE INSERT ON `support_inquiries`
WHEN NEW.shop_purchase_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM shop_purchases p
    WHERE p.id=NEW.shop_purchase_id AND p.user_id=NEW.user_id
  ) THEN RAISE(ABORT,'shop_support_purchase_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER `shop_support_purchase_validate_before_update`
BEFORE UPDATE OF `shop_purchase_id`,`user_id` ON `support_inquiries`
WHEN NEW.shop_purchase_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM shop_purchases p
    WHERE p.id=NEW.shop_purchase_id AND p.user_id=NEW.user_id
  ) THEN RAISE(ABORT,'shop_support_purchase_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER `shop_purchase_links_validate_before_update`
BEFORE UPDATE OF `voucher_id`,`support_inquiry_id`,`product_id`,`user_id`,`status`,`delivered_at` ON `shop_purchases`
BEGIN
  SELECT CASE WHEN (NEW.status='pending_delivery' AND (NEW.voucher_id IS NOT NULL OR NEW.delivered_at IS NOT NULL))
    OR (NEW.status='delivered' AND (NEW.voucher_id IS NULL OR NEW.support_inquiry_id IS NULL OR NEW.delivered_at IS NULL))
    THEN RAISE(ABORT,'shop_purchase_state_invalid') END;
  SELECT CASE WHEN NEW.voucher_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM shop_vouchers v
    WHERE v.id=NEW.voucher_id AND v.purchase_id=NEW.id AND v.product_id=NEW.product_id
  ) THEN RAISE(ABORT,'shop_purchase_voucher_invalid') END;
  SELECT CASE WHEN NEW.support_inquiry_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM support_inquiries s
    WHERE s.id=NEW.support_inquiry_id AND s.shop_purchase_id=NEW.id AND s.user_id=NEW.user_id
  ) THEN RAISE(ABORT,'shop_purchase_support_invalid') END;
END;
--> statement-breakpoint
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
