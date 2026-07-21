export const COMMUNITY_TAGS = ["후방", "꿀팁", "일상", "유머", "이슈"] as const;

export type CommunityTag = (typeof COMMUNITY_TAGS)[number];

export const COMMUNITY_TAG_BITS: Readonly<Record<CommunityTag, number>> = Object.freeze({
  후방: 1,
  꿀팁: 2,
  일상: 4,
  유머: 8,
  이슈: 16,
});

export type CommunityTagsValidation =
  | { ok: true; tags: CommunityTag[]; mask: number }
  | { ok: false; error: string };

const COMMUNITY_TAG_SET = new Set<string>(COMMUNITY_TAGS);

export function isCommunityBoardCategory(category: unknown): category is "community" | "gifs" {
  return category === "community" || category === "gifs";
}

export function communityTagMaskFromTags(tags: readonly CommunityTag[]): number {
  return tags.reduce((mask, tag) => mask | COMMUNITY_TAG_BITS[tag], 0);
}

export function validateCommunityTags(value: unknown): CommunityTagsValidation {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "머릿글을 하나 이상 선택해 주세요." };
  }

  if (!value.every((tag): tag is CommunityTag => typeof tag === "string" && COMMUNITY_TAG_SET.has(tag))) {
    return { ok: false, error: "선택할 수 없는 머릿글이 포함되어 있습니다." };
  }

  if (new Set(value).size !== value.length) {
    return { ok: false, error: "같은 머릿글은 한 번만 선택할 수 있습니다." };
  }

  const selected = new Set<CommunityTag>(value);
  const tags = COMMUNITY_TAGS.filter((tag) => selected.has(tag));
  return { ok: true, tags, mask: communityTagMaskFromTags(tags) };
}

export function communityTagsFromMask(mask: unknown, category: unknown): CommunityTag[] {
  if (!isCommunityBoardCategory(category)) return [];

  const normalizedMask = typeof mask === "number" && Number.isSafeInteger(mask) && mask >= 0 ? mask : 0;
  const tags = COMMUNITY_TAGS.filter((tag) => (normalizedMask & COMMUNITY_TAG_BITS[tag]) !== 0);

  // Existing community rows predate tag storage. Treat those rows as "일상"
  // until the migration backfill (or a later edit) persists an explicit tag.
  return tags.length > 0 ? tags : ["일상"];
}
