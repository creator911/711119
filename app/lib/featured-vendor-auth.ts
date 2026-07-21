import { env } from "cloudflare:workers";
import { adminSession } from "./admin-auth";
import { memberFromSession, type MemberSession } from "./member-auth";
import { isFeaturedVendorSlot } from "./featured-vendors";

export type FeaturedVendorAccess = {
  actor: { type: "admin"; label: string } | { type: "member"; label: string; member: MemberSession } | null;
  editableSlots: number[];
};

export async function featuredVendorAccess(request: Request): Promise<FeaturedVendorAccess> {
  const [operator, member] = await Promise.all([
    adminSession(request, env),
    memberFromSession(request),
  ]);
  if (operator) {
    return { actor: { type: "admin", label: `admin:${operator.username}` }, editableSlots: [1, 2, 3, 4] };
  }
  if (!member) return { actor: null, editableSlots: [] };
  if (member.level === 10) {
    return { actor: { type: "member", label: `member:${member.id}`, member }, editableSlots: [1, 2, 3, 4] };
  }
  const result = await env.DB.prepare(`
    SELECT p.slot
    FROM featured_vendor_permissions p
    JOIN users u ON u.id=p.user_id
    WHERE p.user_id=? AND u.status='active' AND u.is_director=1 AND u.is_partner=1
    ORDER BY p.slot
  `).bind(member.id).all<{ slot: number }>();
  const editableSlots = result.results.map((row) => Number(row.slot)).filter(isFeaturedVendorSlot);
  return { actor: { type: "member", label: `member:${member.id}`, member }, editableSlots };
}
