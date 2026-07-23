CREATE INDEX `users_created_id_idx` ON `users` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `users_points_id_idx` ON `users` (`points`,`id`);--> statement-breakpoint
CREATE INDEX `users_level_id_idx` ON `users` (`level`,`id`);--> statement-breakpoint
CREATE INDEX `users_director_created_id_idx` ON `users` (`is_director`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `users_partner_created_id_idx` ON `users` (`is_partner`,`created_at`,`id`);