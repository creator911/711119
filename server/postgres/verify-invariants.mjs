import pg from "pg";

const { Client } = pg;
const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required");

const checks = [
  {
    name: "non_negative_product_stock",
    sql: "SELECT COUNT(*)::bigint AS violations FROM shop_products WHERE stock < 0",
  },
  {
    name: "one_attendance_per_user_day",
    sql: `
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT user_id, attendance_date
        FROM attendance
        GROUP BY user_id, attendance_date
        HAVING COUNT(*) > 1
      ) duplicate_attendance
    `,
  },
  {
    name: "one_vote_per_user_poll",
    sql: `
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT poll_id, user_id
        FROM post_poll_votes
        GROUP BY poll_id, user_id
        HAVING COUNT(*) > 1
      ) duplicate_votes
    `,
  },
  {
    name: "one_recommendation_per_user_post",
    sql: `
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT post_id, user_id
        FROM post_recommendations
        GROUP BY post_id, user_id
        HAVING COUNT(*) > 1
      ) duplicate_recommendations
    `,
  },
  {
    name: "one_report_per_user_post",
    sql: `
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT post_id, user_id
        FROM post_reports
        GROUP BY post_id, user_id
        HAVING COUNT(*) > 1
      ) duplicate_reports
    `,
  },
  {
    name: "one_purchase_per_request",
    sql: `
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT user_id, request_key
        FROM shop_purchases
        GROUP BY user_id, request_key
        HAVING COUNT(*) > 1
      ) duplicate_purchases
    `,
  },
  {
    name: "one_voucher_per_purchase",
    sql: `
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT purchase_id
        FROM shop_vouchers
        WHERE purchase_id IS NOT NULL
        GROUP BY purchase_id
        HAVING COUNT(*) > 1
      ) duplicate_vouchers
    `,
  },
  {
    name: "one_jump_counter_per_user_day",
    sql: `
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT user_id, jump_date
        FROM vendor_post_jump_usage
        GROUP BY user_id, jump_date
        HAVING COUNT(*) > 1 OR MAX(used_count) > 30 OR MIN(used_count) < 0
      ) invalid_jump_usage
    `,
  },
  {
    name: "one_event_payout_per_period_user",
    sql: `
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT period_type, board_type, period_start, user_id
        FROM event_reward_payouts
        GROUP BY period_type, board_type, period_start, user_id
        HAVING COUNT(*) > 1
      ) duplicate_payouts
    `,
  },
  {
    name: "one_content_reward_per_reference",
    sql: `
      SELECT COUNT(*)::bigint AS violations
      FROM (
        SELECT user_id, type, reference
        FROM point_ledger
        WHERE type IN ('post_create','review_create','comment_create')
          AND reference IS NOT NULL
        GROUP BY user_id, type, reference
        HAVING COUNT(*) > 1
      ) duplicate_rewards
    `,
  },
];

const client = new Client({
  connectionString,
  ssl: process.env.POSTGRES_SSL === "disable" ? false : { rejectUnauthorized: false },
  application_name: "nara001-invariant-verifier",
});
await client.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const results = [];
  for (const check of checks) {
    const result = await client.query(check.sql);
    results.push({ name: check.name, violations: Number(result.rows[0]?.violations ?? 0) });
  }
  await client.query("COMMIT");
  const failed = results.filter((result) => result.violations > 0);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results, ok: failed.length === 0 }, null, 2));
  if (failed.length) process.exitCode = 1;
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
