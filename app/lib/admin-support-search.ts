export const MAX_ADMIN_SUPPORT_SEARCH_CHARACTERS = 80;
export const MAX_ADMIN_SUPPORT_SEARCH_BYTES = 80;

const encoder = new TextEncoder();

export const escapeAdminSupportSearchLiteral = (value: string) => value.replace(/[!%_]/g, (character) => `!${character}`);

export function adminSupportPrefixSearch(value: string) {
  const query = value.trim().replace(/\s+/g, " ");
  if (query.length > MAX_ADMIN_SUPPORT_SEARCH_CHARACTERS || encoder.encode(query).byteLength > MAX_ADMIN_SUPPORT_SEARCH_BYTES) return null;
  return { query, pattern: `${escapeAdminSupportSearchLiteral(query)}%` };
}

export const ADMIN_SUPPORT_MATCHED_IDS_CTE_SQL = `
  WITH matched_ids(id) AS (
    SELECT i.id
    FROM support_inquiries i INDEXED BY support_inquiries_admin_title_nocase_idx
    WHERE i.kind=? AND i.status != 'deleted'
      AND i.title COLLATE NOCASE LIKE ? ESCAPE '!'
    UNION
    SELECT i.id
    FROM users u INDEXED BY users_username_nocase_id_idx
    JOIN support_inquiries i INDEXED BY support_inquiries_member_kind_id_idx
      ON i.user_id=u.id AND i.kind=?
    WHERE u.username COLLATE NOCASE LIKE ? ESCAPE '!'
      AND i.status != 'deleted'
    UNION
    SELECT i.id
    FROM users u INDEXED BY users_nickname_nocase_id_idx
    JOIN support_inquiries i INDEXED BY support_inquiries_member_kind_id_idx
      ON i.user_id=u.id AND i.kind=?
    WHERE u.nickname COLLATE NOCASE LIKE ? ESCAPE '!'
      AND i.status != 'deleted'
  )`;

export const adminSupportSearchBindings = (kind: "support" | "partner", pattern: string) => [
  kind,
  pattern,
  kind,
  pattern,
  kind,
  pattern,
] as const;
