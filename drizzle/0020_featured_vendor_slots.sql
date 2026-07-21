CREATE TABLE `featured_vendor_posts` (
	`slot` integer PRIMARY KEY NOT NULL,
	`industry` text NOT NULL,
	`region` text NOT NULL,
	`district` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`cover_key` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text DEFAULT 'system' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `featured_vendor_posts_slot_range_check` CHECK (`slot` BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE TABLE `featured_vendor_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`slot` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`slot`) REFERENCES `featured_vendor_posts`(`slot`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `featured_vendor_permissions_slot_range_check` CHECK (`slot` BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `featured_vendor_permissions_user_slot_unique` ON `featured_vendor_permissions` (`user_id`,`slot`);
--> statement-breakpoint
CREATE INDEX `featured_vendor_permissions_slot_idx` ON `featured_vendor_permissions` (`slot`);
--> statement-breakpoint
INSERT INTO `featured_vendor_posts` (`slot`,`industry`,`region`,`district`,`title`,`body`,`cover_key`,`version`,`updated_by`,`created_at`,`updated_at`) VALUES
	(1,'오피','서울 강남','강남','강남 프리미엄 라운지','<p>도심에서 편안하게 쉬어갈 수 있는 프리미엄 공간입니다.</p><p>이용 안내와 상세 정보는 제휴 담당자가 최신 내용으로 업데이트합니다.</p>',NULL,1,'system','2026-07-20T00:00:00.000Z','2026-07-20T00:00:00.000Z'),
	(2,'건마','서울 강남','논현','논현 모던 힐링 스파','<p>차분한 분위기와 깔끔한 시설을 갖춘 논현 지역 힐링 공간입니다.</p><p>운영 시간과 프로그램은 상세 내용을 확인해 주세요.</p>',NULL,1,'system','2026-07-20T00:00:00.000Z','2026-07-20T00:00:00.000Z'),
	(3,'휴게텔','서울 강남','삼성','삼성 시티 나이트 라운지','<p>삼성 지역에서 편안한 휴식을 제공하는 제휴 공간입니다.</p><p>방문 전 최신 이용 안내를 확인해 주세요.</p>',NULL,1,'system','2026-07-20T00:00:00.000Z','2026-07-20T00:00:00.000Z'),
	(4,'룸,술','서울 강남','서초','서초 웰니스 테라피 룸','<p>서초 지역의 모던한 분위기와 편안한 공간을 소개합니다.</p><p>상세 프로그램과 운영 정보는 본문에서 안내합니다.</p>',NULL,1,'system','2026-07-20T00:00:00.000Z','2026-07-20T00:00:00.000Z');
--> statement-breakpoint
CREATE TRIGGER `featured_vendor_posts_prevent_delete`
BEFORE DELETE ON `featured_vendor_posts`
BEGIN
	SELECT RAISE(ABORT, 'fixed_featured_vendor_post_cannot_be_deleted');
END;
