CREATE INDEX `support_inquiries_member_kind_id_idx` ON `support_inquiries` (`user_id`,`kind`,`id`);--> statement-breakpoint
CREATE INDEX `support_inquiries_admin_kind_status_updated_idx` ON `support_inquiries` (`kind`,`status`,`staff_unread`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `support_inquiry_replies_inquiry_id_idx` ON `support_inquiry_replies` (`inquiry_id`,`id`);