import { env } from "cloudflare:workers";

export type MemberSession = {
  id: number;
  username: string;
  nickname: string;
  points: number;
  level: number;
  role: string;
};

const tokenOf = (request: Request) => request.headers.get("cookie")?.match(/(?:^|; )cn_session=([^;]+)/)?.[1];

export async function memberFromSession(request: Request) {
  const token = tokenOf(request);
  if (!token) return null;
  return env.DB.prepare(`
    SELECT u.id, u.username, u.nickname, u.points, u.level, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.status = 'active'
  `).bind(token, new Date().toISOString()).first<MemberSession>();
}
