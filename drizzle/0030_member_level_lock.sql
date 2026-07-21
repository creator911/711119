ALTER TABLE users ADD COLUMN level_locked integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE users SET level_locked=1 WHERE level<>1;
