ALTER TABLE `posts` ADD `community_tag_mask` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `posts`
SET `community_tag_mask` = 4
WHERE `category` IN ('community', 'gifs')
  AND `community_tag_mask` = 0;
