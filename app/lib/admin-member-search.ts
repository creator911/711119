export const MAX_ADMIN_MEMBER_SEARCH_CHARACTERS = 40;
export const MAX_ADMIN_MEMBER_SEARCH_PATTERN_BYTES = 50;
export const MIN_ADMIN_MEMBER_SEARCH_CHARACTERS = 2;
export const ADMIN_MEMBER_PREFIX_WHERE_SQL = "username COLLATE NOCASE LIKE ? ESCAPE '!' OR nickname COLLATE NOCASE LIKE ? ESCAPE '!'";

const encoder = new TextEncoder();

export const escapeAdminMemberSearchLiteral = (value: string) => value.replace(/[!%_]/g, (character) => `!${character}`);

export function adminMemberPrefixSearch(value: string) {
  const query = value.trim();
  if (query.length > MAX_ADMIN_MEMBER_SEARCH_CHARACTERS) return null;
  const pattern = `${escapeAdminMemberSearchLiteral(query)}%`;
  if (encoder.encode(pattern).byteLength > MAX_ADMIN_MEMBER_SEARCH_PATTERN_BYTES) return null;
  return { query, pattern };
}
