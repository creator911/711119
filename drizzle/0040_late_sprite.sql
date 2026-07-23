CREATE TABLE `event_activity_rollups` (
	`period_type` text NOT NULL,
	`period_start` text NOT NULL,
	`board_type` text NOT NULL,
	`user_id` integer NOT NULL,
	`activity_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_activity_rollups_period_user_unique` ON `event_activity_rollups` (`period_type`,`period_start`,`board_type`,`user_id`);--> statement-breakpoint
CREATE INDEX `event_activity_rollups_ranking_idx` ON `event_activity_rollups` (`period_type`,`board_type`,`period_start`,`activity_count` DESC,`user_id`);--> statement-breakpoint
CREATE INDEX `event_activity_rollups_period_discovery_idx` ON `event_activity_rollups` (`period_type`,`period_start`);--> statement-breakpoint

INSERT INTO site_settings(key,value,updated_by,updated_at)
VALUES(
  'event_reward_catchup_watermark:weekly',
  strftime('%Y-%m-%dT%H:%M:00.000Z',datetime('now','+9 hours','-' || ((CAST(strftime('%w',datetime('now','+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')),
  'migration-0040',strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
ON CONFLICT(key) DO NOTHING;--> statement-breakpoint
INSERT INTO site_settings(key,value,updated_by,updated_at)
VALUES(
  'event_reward_catchup_watermark:monthly',
  strftime('%Y-%m-%dT%H:%M:00.000Z',datetime('now','+9 hours','start of month','-9 hours')),
  'migration-0040',strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
ON CONFLICT(key) DO NOTHING;--> statement-breakpoint

INSERT INTO event_activity_rollups(period_type,period_start,board_type,user_id,activity_count,updated_at)
SELECT period_type,period_start,board_type,user_id,SUM(activity_count),MAX(updated_at)
FROM (
  SELECT 'weekly' AS period_type,
    strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')) AS period_start,
    'posts' AS board_type,author_id AS user_id,COUNT(*) AS activity_count,MAX(created_at) AS updated_at
  FROM posts
  WHERE status='published' AND author_id>0 AND category IN ('reviews','gifs','community')
    AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-70 days')
  GROUP BY period_start,author_id
  UNION ALL
  SELECT 'monthly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(created_at,'+9 hours','start of month','-9 hours')),
    'posts',author_id,COUNT(*),MAX(created_at)
  FROM posts
  WHERE status='published' AND author_id>0 AND category IN ('reviews','gifs','community')
    AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-70 days')
  GROUP BY 2,author_id
  UNION ALL
  SELECT 'weekly',
    strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')),
    'comments',user_id,COUNT(*),MAX(created_at)
  FROM post_comments
  WHERE status='published' AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-70 days')
  GROUP BY 2,user_id
  UNION ALL
  SELECT 'monthly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(created_at,'+9 hours','start of month','-9 hours')),
    'comments',user_id,COUNT(*),MAX(created_at)
  FROM post_comments
  WHERE status='published' AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-70 days')
  GROUP BY 2,user_id
  UNION ALL
  SELECT 'weekly',
    strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(attendance_date,'-' || ((CAST(strftime('%w',attendance_date) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')),
    'comments',user_id,COUNT(*),MAX(COALESCE(NULLIF(created_at,''),attendance_date))
  FROM attendance WHERE attendance_date>=date('now','-70 days') GROUP BY 2,user_id
  UNION ALL
  SELECT 'monthly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(attendance_date,'start of month','-9 hours')),
    'comments',user_id,COUNT(*),MAX(COALESCE(NULLIF(created_at,''),attendance_date))
  FROM attendance WHERE attendance_date>=date('now','-70 days') GROUP BY 2,user_id
)
WHERE period_start IS NOT NULL
GROUP BY period_type,period_start,board_type,user_id;--> statement-breakpoint

CREATE TRIGGER event_activity_posts_insert AFTER INSERT ON posts
WHEN NEW.status='published' AND NEW.author_id>0 AND NEW.category IN ('reviews','gifs','community')
BEGIN
  INSERT INTO event_activity_rollups(period_type,period_start,board_type,user_id,activity_count,updated_at)
  VALUES
    ('weekly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(NEW.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')),'posts',NEW.author_id,1,NEW.created_at),
    ('monthly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.created_at,'+9 hours','start of month','-9 hours')),'posts',NEW.author_id,1,NEW.created_at)
  ON CONFLICT(period_type,period_start,board_type,user_id) DO UPDATE SET
    activity_count=activity_count+1,updated_at=excluded.updated_at;
END;--> statement-breakpoint

CREATE TRIGGER event_activity_posts_delete AFTER DELETE ON posts
WHEN OLD.status='published' AND OLD.author_id>0 AND OLD.category IN ('reviews','gifs','community')
BEGIN
  UPDATE event_activity_rollups SET activity_count=activity_count-1,updated_at=CURRENT_TIMESTAMP
  WHERE board_type='posts' AND user_id=OLD.author_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(OLD.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','start of month','-9 hours')))
  );
  DELETE FROM event_activity_rollups
  WHERE activity_count<=0 AND board_type='posts' AND user_id=OLD.author_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(OLD.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','start of month','-9 hours')))
  );
END;--> statement-breakpoint

CREATE TRIGGER event_activity_posts_update AFTER UPDATE OF status,author_id,category,created_at ON posts
BEGIN
  UPDATE event_activity_rollups SET activity_count=activity_count-1,updated_at=CURRENT_TIMESTAMP
  WHERE OLD.status='published' AND OLD.author_id>0 AND OLD.category IN ('reviews','gifs','community')
    AND board_type='posts' AND user_id=OLD.author_id AND (
      (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(OLD.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
      OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','start of month','-9 hours')))
    );
  DELETE FROM event_activity_rollups
  WHERE activity_count<=0 AND board_type='posts' AND user_id=OLD.author_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(OLD.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','start of month','-9 hours')))
  );
  INSERT INTO event_activity_rollups(period_type,period_start,board_type,user_id,activity_count,updated_at)
  SELECT 'weekly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(NEW.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')),'posts',NEW.author_id,1,NEW.created_at
  WHERE NEW.status='published' AND NEW.author_id>0 AND NEW.category IN ('reviews','gifs','community')
  UNION ALL
  SELECT 'monthly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.created_at,'+9 hours','start of month','-9 hours')),'posts',NEW.author_id,1,NEW.created_at
  WHERE NEW.status='published' AND NEW.author_id>0 AND NEW.category IN ('reviews','gifs','community')
  ON CONFLICT(period_type,period_start,board_type,user_id) DO UPDATE SET
    activity_count=activity_count+1,updated_at=excluded.updated_at;
END;--> statement-breakpoint

CREATE TRIGGER event_activity_comments_insert AFTER INSERT ON post_comments
WHEN NEW.status='published'
BEGIN
  INSERT INTO event_activity_rollups(period_type,period_start,board_type,user_id,activity_count,updated_at)
  VALUES
    ('weekly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(NEW.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')),'comments',NEW.user_id,1,NEW.created_at),
    ('monthly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.created_at,'+9 hours','start of month','-9 hours')),'comments',NEW.user_id,1,NEW.created_at)
  ON CONFLICT(period_type,period_start,board_type,user_id) DO UPDATE SET activity_count=activity_count+1,updated_at=excluded.updated_at;
END;--> statement-breakpoint

CREATE TRIGGER event_activity_comments_delete AFTER DELETE ON post_comments
WHEN OLD.status='published'
BEGIN
  UPDATE event_activity_rollups SET activity_count=activity_count-1,updated_at=CURRENT_TIMESTAMP
  WHERE board_type='comments' AND user_id=OLD.user_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(OLD.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','start of month','-9 hours')))
  );
  DELETE FROM event_activity_rollups
  WHERE activity_count<=0 AND board_type='comments' AND user_id=OLD.user_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(OLD.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','start of month','-9 hours')))
  );
END;--> statement-breakpoint

CREATE TRIGGER event_activity_comments_update AFTER UPDATE OF status,user_id,created_at ON post_comments
BEGIN
  UPDATE event_activity_rollups SET activity_count=activity_count-1,updated_at=CURRENT_TIMESTAMP
  WHERE OLD.status='published' AND board_type='comments' AND user_id=OLD.user_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(OLD.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','start of month','-9 hours')))
  );
  DELETE FROM event_activity_rollups
  WHERE activity_count<=0 AND board_type='comments' AND user_id=OLD.user_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(OLD.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.created_at,'+9 hours','start of month','-9 hours')))
  );
  INSERT INTO event_activity_rollups(period_type,period_start,board_type,user_id,activity_count,updated_at)
  SELECT 'weekly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.created_at,'+9 hours','-' || ((CAST(strftime('%w',datetime(NEW.created_at,'+9 hours')) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')),'comments',NEW.user_id,1,NEW.created_at WHERE NEW.status='published'
  UNION ALL
  SELECT 'monthly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.created_at,'+9 hours','start of month','-9 hours')),'comments',NEW.user_id,1,NEW.created_at WHERE NEW.status='published'
  ON CONFLICT(period_type,period_start,board_type,user_id) DO UPDATE SET activity_count=activity_count+1,updated_at=excluded.updated_at;
END;--> statement-breakpoint

CREATE TRIGGER event_activity_attendance_insert AFTER INSERT ON attendance
BEGIN
  INSERT INTO event_activity_rollups(period_type,period_start,board_type,user_id,activity_count,updated_at)
  VALUES
    ('weekly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.attendance_date,'-' || ((CAST(strftime('%w',NEW.attendance_date) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')),'comments',NEW.user_id,1,COALESCE(NULLIF(NEW.created_at,''),NEW.attendance_date)),
    ('monthly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.attendance_date,'start of month','-9 hours')),'comments',NEW.user_id,1,COALESCE(NULLIF(NEW.created_at,''),NEW.attendance_date))
  ON CONFLICT(period_type,period_start,board_type,user_id) DO UPDATE SET activity_count=activity_count+1,updated_at=excluded.updated_at;
END;--> statement-breakpoint

CREATE TRIGGER event_activity_attendance_delete AFTER DELETE ON attendance
BEGIN
  UPDATE event_activity_rollups SET activity_count=activity_count-1,updated_at=CURRENT_TIMESTAMP
  WHERE board_type='comments' AND user_id=OLD.user_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.attendance_date,'-' || ((CAST(strftime('%w',OLD.attendance_date) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.attendance_date,'start of month','-9 hours')))
  );
  DELETE FROM event_activity_rollups
  WHERE activity_count<=0 AND board_type='comments' AND user_id=OLD.user_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.attendance_date,'-' || ((CAST(strftime('%w',OLD.attendance_date) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.attendance_date,'start of month','-9 hours')))
  );
END;--> statement-breakpoint

CREATE TRIGGER event_activity_attendance_update AFTER UPDATE OF user_id,attendance_date ON attendance
BEGIN
  UPDATE event_activity_rollups SET activity_count=activity_count-1,updated_at=CURRENT_TIMESTAMP
  WHERE board_type='comments' AND user_id=OLD.user_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.attendance_date,'-' || ((CAST(strftime('%w',OLD.attendance_date) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.attendance_date,'start of month','-9 hours')))
  );
  DELETE FROM event_activity_rollups
  WHERE activity_count<=0 AND board_type='comments' AND user_id=OLD.user_id AND (
    (period_type='weekly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.attendance_date,'-' || ((CAST(strftime('%w',OLD.attendance_date) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')))
    OR (period_type='monthly' AND period_start=strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(OLD.attendance_date,'start of month','-9 hours')))
  );
  INSERT INTO event_activity_rollups(period_type,period_start,board_type,user_id,activity_count,updated_at)
  VALUES
    ('weekly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.attendance_date,'-' || ((CAST(strftime('%w',NEW.attendance_date) AS INTEGER)+6)%7) || ' days','start of day','-9 hours')),'comments',NEW.user_id,1,COALESCE(NULLIF(NEW.created_at,''),NEW.attendance_date)),
    ('monthly',strftime('%Y-%m-%dT%H:%M:00.000Z',datetime(NEW.attendance_date,'start of month','-9 hours')),'comments',NEW.user_id,1,COALESCE(NULLIF(NEW.created_at,''),NEW.attendance_date))
  ON CONFLICT(period_type,period_start,board_type,user_id) DO UPDATE SET activity_count=activity_count+1,updated_at=excluded.updated_at;
END;
