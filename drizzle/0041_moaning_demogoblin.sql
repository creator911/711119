CREATE INDEX `support_inquiries_admin_title_nocase_idx` ON `support_inquiries` (`kind`,"title" COLLATE NOCASE,`id`) WHERE "support_inquiries"."status" != 'deleted';--> statement-breakpoint
CREATE INDEX `point_ledger_attendance_streak_user_reference_idx` ON `point_ledger` (`user_id`,`reference`) WHERE `type`='attendance_streak_reward';--> statement-breakpoint

UPDATE users SET is_director=1 WHERE is_partner=1 AND is_director<>1;--> statement-breakpoint
CREATE TRIGGER users_partner_requires_director_after_insert
AFTER INSERT ON users
WHEN NEW.is_partner=1 AND NEW.is_director<>1
BEGIN
  UPDATE users SET is_director=1 WHERE id=NEW.id;
END;--> statement-breakpoint
CREATE TRIGGER users_partner_requires_director_after_update
AFTER UPDATE OF is_partner,is_director ON users
WHEN NEW.is_partner=1 AND NEW.is_director<>1
BEGIN
  UPDATE users SET is_director=1 WHERE id=NEW.id;
END;--> statement-breakpoint

-- Repair legacy attendance milestone rows whose old multi-step payout stopped
-- after the marker insert. Both the old streak:<days>:<date> and the current
-- streak:<days> ledger formats suppress a second award.
UPDATE users
SET points=points+COALESCE((
  SELECT SUM(r.points)
  FROM attendance_streak_rewards r
  WHERE r.user_id=users.id AND r.points>0
    AND NOT EXISTS(
      SELECT 1 FROM point_ledger l
      WHERE l.user_id=r.user_id AND l.type='attendance_streak_reward'
        AND (
          l.reference='streak:' || CAST(r.milestone_days AS TEXT)
          OR l.reference LIKE 'streak:' || CAST(r.milestone_days AS TEXT) || ':%'
        )
    )
),0)
WHERE id IN(
  SELECT r.user_id FROM attendance_streak_rewards r
  WHERE r.points>0
    AND NOT EXISTS(
      SELECT 1 FROM point_ledger l
      WHERE l.user_id=r.user_id AND l.type='attendance_streak_reward'
        AND (
          l.reference='streak:' || CAST(r.milestone_days AS TEXT)
          OR l.reference LIKE 'streak:' || CAST(r.milestone_days AS TEXT) || ':%'
        )
    )
);--> statement-breakpoint
INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
SELECT r.user_id,r.points,'attendance_streak_reward','complete',
  'streak:' || CAST(r.milestone_days AS TEXT),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM attendance_streak_rewards r
WHERE r.points>0 AND NOT EXISTS(
  SELECT 1 FROM point_ledger l
  WHERE l.user_id=r.user_id AND l.type='attendance_streak_reward'
    AND (
      l.reference='streak:' || CAST(r.milestone_days AS TEXT)
      OR l.reference LIKE 'streak:' || CAST(r.milestone_days AS TEXT) || ':%'
    )
);--> statement-breakpoint

-- Older settlement code protected a user within a period but did not protect a
-- rank slot. If a retry observed a changed ranking, two users could therefore
-- own rank 1. The lowest payout id is the first written snapshot and remains
-- authoritative. Preserve the historical ledger, but offset any later paid
-- duplicate with an explicit correction before removing its payout snapshot.
UPDATE users
SET points=points-COALESCE((
  SELECT SUM(l.amount)
  FROM event_reward_payouts p
  JOIN point_ledger l
    ON l.user_id=p.user_id AND l.type='event_reward'
    AND l.reference=
      'event:' || p.period_type || ':' || p.board_type || ':' ||
      date(datetime(p.period_start,'+9 hours')) || ':rank' || CAST(p.rank AS TEXT)
  WHERE p.user_id=users.id AND p.id<>(
    SELECT MIN(canonical.id)
    FROM event_reward_payouts canonical
    WHERE canonical.period_type=p.period_type AND canonical.board_type=p.board_type
      AND canonical.period_start=p.period_start AND canonical.rank=p.rank
  ) AND l.amount>0
),0)
WHERE id IN(
  SELECT p.user_id
  FROM event_reward_payouts p
  JOIN point_ledger l
    ON l.user_id=p.user_id AND l.type='event_reward'
    AND l.reference=
      'event:' || p.period_type || ':' || p.board_type || ':' ||
      date(datetime(p.period_start,'+9 hours')) || ':rank' || CAST(p.rank AS TEXT)
  WHERE p.id<>(
    SELECT MIN(canonical.id)
    FROM event_reward_payouts canonical
    WHERE canonical.period_type=p.period_type AND canonical.board_type=p.board_type
      AND canonical.period_start=p.period_start AND canonical.rank=p.rank
  ) AND l.amount>0
);--> statement-breakpoint
INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
SELECT p.user_id,-l.amount,'event_reward_correction','complete',
  'event-duplicate-payout:' || CAST(p.id AS TEXT),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM event_reward_payouts p
JOIN point_ledger l
  ON l.user_id=p.user_id AND l.type='event_reward'
  AND l.reference=
    'event:' || p.period_type || ':' || p.board_type || ':' ||
    date(datetime(p.period_start,'+9 hours')) || ':rank' || CAST(p.rank AS TEXT)
WHERE p.id<>(
  SELECT MIN(canonical.id)
  FROM event_reward_payouts canonical
  WHERE canonical.period_type=p.period_type AND canonical.board_type=p.board_type
    AND canonical.period_start=p.period_start AND canonical.rank=p.rank
) AND l.amount>0;--> statement-breakpoint
DELETE FROM event_reward_payouts
WHERE id<>(
  SELECT MIN(canonical.id)
  FROM event_reward_payouts canonical
  WHERE canonical.period_type=event_reward_payouts.period_type
    AND canonical.board_type=event_reward_payouts.board_type
    AND canonical.period_start=event_reward_payouts.period_start
    AND canonical.rank=event_reward_payouts.rank
);--> statement-breakpoint
CREATE UNIQUE INDEX `event_reward_payouts_period_rank_unique`
ON `event_reward_payouts` (`period_type`,`board_type`,`period_start`,`rank`);--> statement-breakpoint

-- A payout snapshot is the authority once written. Repair every legacy event
-- payout lacking its ledger, even when a completion marker already exists or
-- later moderation changed the live ranking.
UPDATE users
SET points=points+COALESCE((
  SELECT SUM(p.points)
  FROM event_reward_payouts p
  WHERE p.user_id=users.id AND p.points>0
    AND NOT EXISTS(
      SELECT 1 FROM point_ledger l
      WHERE l.user_id=p.user_id AND l.type='event_reward'
        AND l.reference=
          'event:' || p.period_type || ':' || p.board_type || ':' ||
          date(datetime(p.period_start,'+9 hours')) || ':rank' || CAST(p.rank AS TEXT)
    )
),0)
WHERE id IN(
  SELECT p.user_id FROM event_reward_payouts p
  WHERE p.points>0
    AND NOT EXISTS(
      SELECT 1 FROM point_ledger l
      WHERE l.user_id=p.user_id AND l.type='event_reward'
        AND l.reference=
          'event:' || p.period_type || ':' || p.board_type || ':' ||
          date(datetime(p.period_start,'+9 hours')) || ':rank' || CAST(p.rank AS TEXT)
    )
);--> statement-breakpoint
INSERT OR IGNORE INTO point_ledger(user_id,amount,type,status,reference,created_at)
SELECT p.user_id,p.points,'event_reward','complete',
  'event:' || p.period_type || ':' || p.board_type || ':' ||
    date(datetime(p.period_start,'+9 hours')) || ':rank' || CAST(p.rank AS TEXT),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM event_reward_payouts p
WHERE p.points>0 AND NOT EXISTS(
  SELECT 1 FROM point_ledger l
  WHERE l.user_id=p.user_id AND l.type='event_reward'
    AND l.reference=
      'event:' || p.period_type || ':' || p.board_type || ':' ||
      date(datetime(p.period_start,'+9 hours')) || ':rank' || CAST(p.rank AS TEXT)
);
