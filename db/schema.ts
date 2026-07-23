import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  nickname: text("nickname").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  signupIp: text("signup_ip").notNull(),
  firstLoginIp: text("first_login_ip"),
  points: integer("points").notNull().default(0),
  level: integer("level").notNull().default(1),
  levelLocked: integer("level_locked", { mode: "boolean" }).notNull().default(false),
  isDirector: integer("is_director", { mode: "boolean" }).notNull().default(false),
  isPartner: integer("is_partner", { mode: "boolean" }).notNull().default(false),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("users_created_id_idx").on(table.createdAt, table.id),
  index("users_points_id_idx").on(table.points, table.id),
  index("users_level_id_idx").on(table.level, table.id),
  index("users_username_nocase_id_idx").on(sql`${table.username} COLLATE NOCASE`, table.id),
  index("users_nickname_nocase_id_idx").on(sql`${table.nickname} COLLATE NOCASE`, table.id),
  index("users_director_created_id_idx").on(table.isDirector, table.createdAt, table.id),
  index("users_partner_created_id_idx").on(table.isPartner, table.createdAt, table.id),
]);

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull(),
  ip: text("ip").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("sessions_expires_token_idx").on(table.expiresAt, table.token)]);

export const attendance = sqliteTable("attendance", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  attendanceDate: text("attendance_date").notNull(),
  pointsAwarded: integer("points_awarded").notNull().default(50),
  greeting: text("greeting").notNull().default("오늘도 출장나라와 함께해요"),
  createdAt: text("created_at").notNull().default(""),
}, (table) => [
  uniqueIndex("attendance_user_date_unique").on(table.userId, table.attendanceDate),
  index("attendance_date_user_idx").on(table.attendanceDate, table.userId),
  index("attendance_date_created_id_idx").on(table.attendanceDate, table.createdAt, table.id),
]);

export const attendanceStreakRewards = sqliteTable("attendance_streak_rewards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  milestoneDays: integer("milestone_days").notNull(),
  points: integer("points").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("attendance_streak_rewards_user_milestone_unique").on(table.userId, table.milestoneDays)]);

export const blockedIps = sqliteTable("blocked_ips", {
  ip: text("ip").primaryKey(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
});

export const pointLedger = sqliteTable("point_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  amount: integer("amount").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("complete"),
  reference: text("reference"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("point_ledger_event_reward_user_reference_unique")
    .on(table.userId, table.type, table.reference)
    .where(sql`${table.type} = 'event_reward' AND ${table.reference} IS NOT NULL`),
  index("point_ledger_attendance_streak_user_reference_idx")
    .on(table.userId, table.reference)
    .where(sql`${table.type} = 'attendance_streak_reward'`),
  index("point_ledger_user_id_idx").on(table.userId, table.id),
  uniqueIndex("point_ledger_content_reward_user_reference_unique")
    .on(table.userId, table.type, table.reference)
    .where(sql`${table.type} IN ('post_create','review_create','comment_create') AND ${table.reference} IS NOT NULL`),
]);

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(),
  communityTagMask: integer("community_tag_mask").notNull().default(0),
  title: text("title").notNull(),
  titleColor: text("title_color").notNull().default(""),
  body: text("body").notNull().default(""),
  authorId: integer("author_id").notNull(),
  authorName: text("author_name").notNull().default(""),
  views: integer("views").notNull().default(0),
  likes: integer("likes").notNull().default(0),
  dislikes: integer("dislikes").notNull().default(0),
  reportCount: integer("report_count").notNull().default(0),
  isNotice: integer("is_notice", { mode: "boolean" }).notNull().default(false),
  isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("published"),
  deletedAt: text("deleted_at"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("posts_category_pinned_id_idx").on(table.category, table.isPinned, table.id),
  index("posts_category_status_created_idx").on(table.category, table.status, table.createdAt),
  index("posts_author_status_idx").on(table.authorId, table.status),
  index("posts_draft_created_id_idx")
    .on(table.createdAt, table.id)
    .where(sql`${table.status} = 'draft'`),
  index("posts_deleted_retention_idx")
    .on(table.deletedAt, table.id)
    .where(sql`${table.status} = 'deleted' AND ${table.deletedAt} IS NOT NULL`),
  index("posts_event_activity_idx")
    .on(table.createdAt, table.authorId)
    .where(sql`${table.status} = 'published' AND ${table.category} IN ('reviews','gifs','community')`),
]);

export const postComments = sqliteTable("post_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  userId: integer("user_id").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("published"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("post_comments_user_status_idx").on(table.userId, table.status),
  index("post_comments_post_status_id_idx").on(table.postId, table.status, table.id),
  index("post_comments_pending_created_id_idx")
    .on(table.createdAt, table.id)
    .where(sql`${table.status} = 'pending'`),
  index("post_comments_event_activity_idx")
    .on(table.createdAt, table.userId)
    .where(sql`${table.status} = 'published'`),
]);

export const adminOwners = sqliteTable("admin_owners", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
});

export const adminIpLoginFailures = sqliteTable("admin_ip_login_failures", {
  ip: text("ip").primaryKey(),
  failureCount: integer("failure_count").notNull().default(0),
  blockedUntil: text("blocked_until"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("admin_ip_login_failures_updated_idx").on(table.updatedAt, table.ip)]);

export const adminAccountLoginFailures = sqliteTable("admin_account_login_failures", {
  username: text("username").primaryKey(),
  failureCount: integer("failure_count").notNull().default(0),
  blockedUntil: text("blocked_until"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("admin_account_login_failures_updated_idx").on(table.updatedAt, table.username)]);

export const memberIpLoginFailures = sqliteTable("member_ip_login_failures", {
  ip: text("ip").primaryKey(),
  failureCount: integer("failure_count").notNull().default(0),
  blockedUntil: text("blocked_until"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("member_ip_login_failures_updated_idx").on(table.updatedAt, table.ip)]);

export const memberAccountLoginFailures = sqliteTable("member_account_login_failures", {
  username: text("username").primaryKey(),
  failureCount: integer("failure_count").notNull().default(0),
  blockedUntil: text("blocked_until"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("member_account_login_failures_updated_idx").on(table.updatedAt, table.username)]);

export const uploadUsage = sqliteTable("upload_usage", {
  id: text("id").primaryKey(),
  actorKey: text("actor_key").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("upload_usage_actor_created_idx").on(table.actorKey, table.createdAt)]);

export const uploadedMedia = sqliteTable("uploaded_media", {
  key: text("key").primaryKey(),
  ownerKey: text("owner_key").notNull(),
  mediaType: text("media_type").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  attachedAt: text("attached_at"),
  claimToken: text("claim_token"),
  claimedAt: text("claimed_at"),
}, (table) => [
  check("uploaded_media_status_check", sql`${table.status} IN ('pending','attaching','attached','pruning')`),
  index("uploaded_media_owner_created_idx").on(table.ownerKey, table.createdAt),
  index("uploaded_media_status_created_idx").on(table.status, table.createdAt),
]);

export const uploadedMediaReferences = sqliteTable("uploaded_media_references", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mediaKey: text("media_key").notNull().references(() => uploadedMedia.key, { onDelete: "cascade" }),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("uploaded_media_references_type_check", sql`${table.resourceType} IN ('post','vendor','support','featured')`),
  uniqueIndex("uploaded_media_references_unique").on(table.mediaKey, table.resourceType, table.resourceId),
  index("uploaded_media_references_resource_idx").on(table.resourceType, table.resourceId),
]);

export const postRecommendations = sqliteTable("post_recommendations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  userId: integer("user_id").notNull(),
  voteType: text("vote_type").notNull().default("up"),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("post_recommendations_post_user_unique").on(table.postId, table.userId)]);

export const postReports = sqliteTable("post_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  userId: integer("user_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("post_reports_post_user_unique").on(table.postId, table.userId)]);

export const postPolls = sqliteTable("post_polls", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(),
  question: text("question").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("post_polls_post_unique").on(table.postId)]);

export const postPollOptions = sqliteTable("post_poll_options", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pollId: integer("poll_id").notNull(),
  position: integer("position").notNull(),
  label: text("label").notNull(),
}, (table) => [uniqueIndex("post_poll_options_poll_position_unique").on(table.pollId, table.position)]);

export const postPollVotes = sqliteTable("post_poll_votes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pollId: integer("poll_id").notNull(),
  optionId: integer("option_id").notNull(),
  userId: integer("user_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("post_poll_votes_poll_user_unique").on(table.pollId, table.userId),
  index("post_poll_votes_option_idx").on(table.optionId),
]);

export const directorRegions = sqliteTable("director_regions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  region: text("region").notNull(),
  district: text("district").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("director_regions_user_region_district_unique").on(table.userId, table.region, table.district),
  index("director_regions_user_idx").on(table.userId),
]);

export const vendorPosts = sqliteTable("vendor_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  industry: text("industry").notNull(),
  region: text("region").notNull(),
  district: text("district").notNull(),
  title: text("title").notNull(),
  titleColor: text("title_color").notNull().default(""),
  body: text("body").notNull().default(""),
  authorId: integer("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("published"),
  jumpedAt: text("jumped_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("vendor_posts_author_region_district_unique").on(table.authorId, table.region, table.district),
  index("vendor_posts_jump_idx").on(table.status, table.jumpedAt, table.id),
  index("vendor_posts_filter_idx").on(table.industry, table.region, table.district, table.id),
]);

export const vendorPostJumpUsage = sqliteTable("vendor_post_jump_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  jumpDate: text("jump_date").notNull(),
  usedCount: integer("used_count").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("vendor_post_jump_usage_user_date_unique").on(table.userId, table.jumpDate),
  index("vendor_post_jump_usage_user_idx").on(table.userId),
]);

export const featuredVendorPosts = sqliteTable("featured_vendor_posts", {
  slot: integer("slot").primaryKey(),
  industry: text("industry").notNull(),
  region: text("region").notNull(),
  district: text("district").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  coverKey: text("cover_key"),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by").notNull().default("system"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("featured_vendor_posts_slot_range_check", sql`${table.slot} BETWEEN 1 AND 4`),
]);

export const featuredVendorPermissions = sqliteTable("featured_vendor_permissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  slot: integer("slot").notNull().references(() => featuredVendorPosts.slot, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull(),
}, (table) => [
  check("featured_vendor_permissions_slot_range_check", sql`${table.slot} BETWEEN 1 AND 4`),
  uniqueIndex("featured_vendor_permissions_user_slot_unique").on(table.userId, table.slot),
  index("featured_vendor_permissions_slot_idx").on(table.slot),
]);

export const shopProducts = sqliteTable("shop_products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  price: integer("price").notNull(),
  stock: integer("stock").notNull().default(0),
  minLevel: integer("min_level").notNull().default(1),
  fallbackImage: text("fallback_image").notNull().default(""),
  coverKey: text("cover_key"),
  status: text("status").notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("shop_products_price_check", sql`${table.price} >= 0`),
  check("shop_products_stock_check", sql`${table.stock} >= 0`),
  check("shop_products_min_level_check", sql`${table.minLevel} BETWEEN 1 AND 9`),
  check("shop_products_status_check", sql`${table.status} IN ('active','hidden')`),
  index("shop_products_status_id_idx").on(table.status, table.id),
]);

export const shopPurchases = sqliteTable("shop_purchases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestKey: text("request_key").notNull(),
  productId: integer("product_id").notNull().references(() => shopProducts.id, { onDelete: "restrict" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  productName: text("product_name").notNull(),
  price: integer("price").notNull(),
  status: text("status").notNull().default("pending_delivery"),
  voucherId: integer("voucher_id"),
  supportInquiryId: integer("support_inquiry_id"),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at"),
}, (table) => [
  check("shop_purchases_price_check", sql`${table.price} >= 0`),
  check("shop_purchases_status_check", sql`${table.status} IN ('pending_delivery','delivered')`),
  uniqueIndex("shop_purchases_user_request_unique").on(table.userId, table.requestKey),
  uniqueIndex("shop_purchases_voucher_unique").on(table.voucherId),
  uniqueIndex("shop_purchases_support_unique").on(table.supportInquiryId),
  index("shop_purchases_product_status_id_idx").on(table.productId, table.status, table.id),
  index("shop_purchases_user_id_idx").on(table.userId, table.id),
]);

export const shopVouchers = sqliteTable("shop_vouchers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productId: integer("product_id").notNull().references(() => shopProducts.id, { onDelete: "restrict" }),
  objectKey: text("object_key").notNull().unique(),
  originalName: text("original_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  status: text("status").notNull().default("available"),
  purchaseId: integer("purchase_id"),
  createdAt: text("created_at").notNull(),
  assignedAt: text("assigned_at"),
}, (table) => [
  check("shop_vouchers_size_check", sql`${table.sizeBytes} > 0`),
  check("shop_vouchers_status_check", sql`${table.status} IN ('available','reserved','delivered')`),
  uniqueIndex("shop_vouchers_purchase_unique").on(table.purchaseId),
  index("shop_vouchers_product_status_id_idx").on(table.productId, table.status, table.id),
]);

export const shopVoucherCleanupQueue = sqliteTable("shop_voucher_cleanup_queue", {
  voucherId: integer("voucher_id").primaryKey(),
  productId: integer("product_id").notNull(),
  objectKey: text("object_key").notNull().unique(),
  cleanupToken: text("cleanup_token").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  createdAt: text("created_at").notNull(),
}, (table) => [
    index("shop_voucher_cleanup_product_id_idx").on(table.productId, table.attempts, table.voucherId),
  index("shop_voucher_cleanup_token_idx").on(table.cleanupToken),
]);

export const supportRooms = sqliteTable("support_rooms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().unique(),
  status: text("status").notNull().default("open"),
  staffUnread: integer("staff_unread").notNull().default(0),
  memberUnread: integer("member_unread").notNull().default(0),
  lastMessage: text("last_message").notNull().default(""),
  lastAt: text("last_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const supportMessages = sqliteTable("support_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: integer("room_id").notNull(),
  senderType: text("sender_type").notNull(),
  senderId: text("sender_id").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
});

export const supportInquiries = sqliteTable("support_inquiries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  kind: text("kind").notNull().default("support"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("open"),
  staffUnread: integer("staff_unread").notNull().default(1),
  memberUnread: integer("member_unread").notNull().default(0),
  shopPurchaseId: integer("shop_purchase_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("support_inquiries_shop_purchase_unique").on(table.shopPurchaseId),
  index("support_inquiries_member_kind_id_idx").on(table.userId, table.kind, table.id),
  index("support_inquiries_admin_kind_status_updated_idx").on(table.kind, table.status, table.staffUnread, table.updatedAt, table.id),
  index("support_inquiries_admin_priority_idx")
    .on(
      table.kind,
      sql`(CASE WHEN ${table.status}='open' THEN 0 ELSE 1 END)`,
      sql`${table.staffUnread} DESC`,
      sql`${table.updatedAt} DESC`,
      sql`${table.id} DESC`,
    )
    .where(sql`${table.status} != 'deleted'`),
  index("support_inquiries_admin_title_nocase_idx")
    .on(table.kind, sql`${table.title} COLLATE NOCASE`, table.id)
    .where(sql`${table.status} != 'deleted'`),
]);

export const supportInquiryReplies = sqliteTable("support_inquiry_replies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inquiryId: integer("inquiry_id").notNull(),
  senderType: text("sender_type").notNull(),
  senderId: text("sender_id").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("support_inquiry_replies_inquiry_id_idx").on(table.inquiryId, table.id)]);

export const supportWriteRateLimits = sqliteTable("support_write_rate_limits", {
  actorKey: text("actor_key").notNull(),
  action: text("action").notNull(),
  windowStart: integer("window_start").notNull(),
  requestCount: integer("request_count").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("support_write_rate_limits_bucket_unique").on(table.actorKey, table.action, table.windowStart),
  index("support_write_rate_limits_window_idx").on(table.windowStart),
]);

export const eventRewardPayouts = sqliteTable("event_reward_payouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  periodType: text("period_type").notNull(),
  boardType: text("board_type").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  userId: integer("user_id").notNull(),
  rank: integer("rank").notNull(),
  activityCount: integer("activity_count").notNull(),
  points: integer("points").notNull(),
  nicknameSnapshot: text("nickname_snapshot"),
  levelSnapshot: integer("level_snapshot"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("event_reward_payouts_period_user_unique").on(table.periodType, table.boardType, table.periodStart, table.userId),
  uniqueIndex("event_reward_payouts_period_rank_unique").on(table.periodType, table.boardType, table.periodStart, table.rank),
  index("event_reward_payouts_period_rank_idx").on(table.periodType, table.boardType, table.periodStart, table.rank),
  index("event_reward_payouts_audit_idx").on(table.periodType, table.periodStart, table.boardType, table.rank),
]);

export const eventActivityRollups = sqliteTable("event_activity_rollups", {
  periodType: text("period_type").notNull(),
  periodStart: text("period_start").notNull(),
  boardType: text("board_type").notNull(),
  userId: integer("user_id").notNull(),
  activityCount: integer("activity_count").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("event_activity_rollups_period_user_unique")
    .on(table.periodType, table.periodStart, table.boardType, table.userId),
  index("event_activity_rollups_ranking_idx")
    .on(table.periodType, table.boardType, table.periodStart, sql`${table.activityCount} DESC`, table.userId),
  index("event_activity_rollups_period_discovery_idx")
    .on(table.periodType, table.periodStart),
]);

export const eventRollupCleanupQueue = sqliteTable("event_rollup_cleanup_queue", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  periodType: text("period_type").notNull(),
  periodStart: text("period_start").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("event_rollup_cleanup_period_unique").on(table.periodType, table.periodStart),
  index("event_rollup_cleanup_created_idx").on(table.createdAt, table.id),
]);

export const siteSettings = sqliteTable("site_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by").notNull().default("system"),
  updatedAt: text("updated_at").notNull(),
});

export const systemAnnouncements = sqliteTable("system_announcements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  content: text("content").notNull(),
  requiresConfirmation: integer("requires_confirmation", { mode: "boolean" }).notNull().default(false),
  startsAt: text("starts_at").notNull(),
  endsAt: text("ends_at").notNull(),
  status: text("status").notNull().default("active"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  check("system_announcements_confirmation_check", sql`${table.requiresConfirmation} IN (0,1)`),
  check("system_announcements_status_check", sql`${table.status} IN ('active','cancelled')`),
  check("system_announcements_window_check", sql`${table.startsAt} < ${table.endsAt}`),
  index("system_announcements_active_window_idx").on(table.status, table.startsAt, table.endsAt, table.id),
  index("system_announcements_ends_id_idx").on(table.endsAt, table.id),
]);

export const systemAnnouncementReceipts = sqliteTable("system_announcement_receipts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  announcementId: integer("announcement_id").notNull().references(() => systemAnnouncements.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deliveredAt: text("delivered_at").notNull(),
  acknowledgedAt: text("acknowledged_at"),
}, (table) => [
  uniqueIndex("system_announcement_receipts_announcement_user_unique").on(table.announcementId, table.userId),
  index("system_announcement_receipts_user_ack_idx").on(table.userId, table.acknowledgedAt, table.announcementId),
]);

export const outboxJobs = sqliteTable("outbox_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  topic: text("topic").notNull(),
  payload: text("payload").notNull().default("{}"),
  status: text("status").notNull().default("pending"),
  availableAt: text("available_at").notNull(),
  lockedAt: text("locked_at"),
  lockedBy: text("locked_by"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  check("outbox_jobs_status_check", sql`${table.status} IN ('pending','processing','complete','failed')`),
  index("outbox_jobs_claim_idx").on(table.status, table.availableAt, table.id),
  index("outbox_jobs_completed_idx").on(table.completedAt, table.id),
]);

export const memberActivityStats = sqliteTable("member_activity_stats", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  attendanceCount: integer("attendance_count").notNull().default(0),
  postCount: integer("post_count").notNull().default(0),
  commentCount: integer("comment_count").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const postStats = sqliteTable("post_stats", {
  postId: integer("post_id").primaryKey().references(() => posts.id, { onDelete: "cascade" }),
  commentCount: integer("comment_count").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const supportStats = sqliteTable("support_stats", {
  inquiryId: integer("inquiry_id").primaryKey().references(() => supportInquiries.id, { onDelete: "cascade" }),
  replyCount: integer("reply_count").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});
