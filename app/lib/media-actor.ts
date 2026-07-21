import { adminSession } from "./admin-auth";
import { memberFromSession } from "./member-auth";
import { adminMediaActorKey, memberMediaActorKey } from "./media-lifecycle";

export async function mediaActorKey(request: Request, environment: unknown) {
  let member = null;
  try { member = await memberFromSession(request); } catch { /* 관리자 쿠키 확인을 계속합니다. */ }
  if (member) return memberMediaActorKey(member.id);
  const operator = await adminSession(request, environment);
  return operator ? adminMediaActorKey(operator.role, operator.username) : null;
}
