export const POPULAR_POST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type PopularPostMetrics = {
  id: string | number;
  likes: number;
  dislikes: number;
  views: number;
  createdAt?: string;
};

export function postCreatedTime(post: Pick<PopularPostMetrics, "createdAt">) {
  if (!post.createdAt) return 0;
  const created = new Date(post.createdAt).getTime();
  return Number.isFinite(created) ? created : 0;
}

export function isInPopularWindow(post: Pick<PopularPostMetrics, "createdAt">, now = Date.now()) {
  const created = postCreatedTime(post);
  return created > 0 && created <= now && created >= now - POPULAR_POST_WINDOW_MS;
}

function numericId(value: string | number) {
  return typeof value === "number" ? value : 0;
}

export function comparePopularPosts(left: PopularPostMetrics, right: PopularPostMetrics) {
  const leftScore = left.likes - left.dislikes;
  const rightScore = right.likes - right.dislikes;
  return rightScore - leftScore
    || right.views - left.views
    || postCreatedTime(right) - postCreatedTime(left)
    || numericId(right.id) - numericId(left.id);
}

export function popularCutoffIso(now = Date.now()) {
  return new Date(now - POPULAR_POST_WINDOW_MS).toISOString();
}
