import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { normalizeAdminMemberFlags } from "../../../lib/admin-member-flags";

type AdminMemberRow = {
  id: number;
  username: string;
  nickname: string;
  signupIp: string;
  firstLoginIp: string | null;
  points: number;
  level: number;
  levelLocked: number | boolean;
  isDirector: number | boolean;
  isPartner: number | boolean;
  status: string;
  createdAt: string;
};

const koreaDayRange = () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const start = new Date(`${today}T00:00:00+09:00`);
  return { today, start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
};

export async function GET(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const { today, start, end } = koreaDayRange();
  const [members, posts, blockedIps, totalMembers, activeMembers, todayMembers, todayPosts, todayAttendance, supportUnread, partnerUnread, shopLowStockProducts] = await Promise.all([
    env.DB.prepare("SELECT id,username,nickname,signup_ip AS signupIp,first_login_ip AS firstLoginIp,points,level,level_locked AS levelLocked,is_director AS isDirector,is_partner AS isPartner,status,created_at AS createdAt FROM users ORDER BY id DESC LIMIT 200").all<AdminMemberRow>(),
    env.DB.prepare("SELECT p.id,p.category,p.title,p.title_color AS titleColor,p.views,p.likes,p.is_notice AS isNotice,p.status,p.created_at AS createdAt,COALESCE(NULLIF(p.author_name,''),u.nickname,'운영자') AS author FROM posts p LEFT JOIN users u ON u.id = p.author_id ORDER BY p.id DESC LIMIT 100").all(),
    env.DB.prepare("SELECT ip,reason,created_at AS createdAt FROM blocked_ips ORDER BY created_at DESC LIMIT 200").all(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE status = 'active'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE created_at >= ? AND created_at < ?").bind(start, end).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM posts WHERE created_at >= ? AND created_at < ?").bind(start, end).first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM attendance WHERE attendance_date = ?").bind(today).first<{ count: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(staff_unread),0) AS count FROM support_inquiries WHERE kind='support' AND status != 'deleted'").first<{ count: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(staff_unread),0) AS count FROM support_inquiries WHERE kind='partner' AND status != 'deleted'").first<{ count: number }>(),
    env.DB.prepare(`
      SELECT COUNT(*) AS count FROM shop_products p
      WHERE p.status='active'
        AND (SELECT COUNT(*) FROM shop_vouchers v WHERE v.product_id=p.id AND v.status='available')<=5
    `).first<{ count: number }>(),
  ]);
  return Response.json({
    operator,
    stats: { totalMembers: totalMembers?.count ?? 0, activeMembers: activeMembers?.count ?? 0, todayMembers: todayMembers?.count ?? 0, todayPosts: todayPosts?.count ?? 0, todayAttendance: todayAttendance?.count ?? 0, supportUnread: supportUnread?.count ?? 0, partnerUnread: partnerUnread?.count ?? 0, shopLowStockProducts: shopLowStockProducts?.count ?? 0 },
    members: members.results.map(normalizeAdminMemberFlags),
    posts: posts.results,
    blockedIps: blockedIps.results,
  });
}
