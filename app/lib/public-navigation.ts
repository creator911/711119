export type PublicView =
  | "home"
  | "notices"
  | "vendors"
  | "community"
  | "reviews"
  | "events"
  | "partner"
  | "support"
  | "mypage"
  | "shop";

export const PUBLIC_VIEW_PATHS: Record<PublicView, string> = {
  home: "/",
  notices: "/notices",
  vendors: "/vendors",
  community: "/community",
  reviews: "/reviews",
  events: "/events",
  partner: "/partner",
  support: "/support",
  mypage: "/mypage",
  shop: "/shop",
};

const PATH_VIEWS = new Map(
  Object.entries(PUBLIC_VIEW_PATHS).map(([view, path]) => [path, view as PublicView]),
);

export const PAGINATED_PUBLIC_VIEWS = new Set<PublicView>([
  "notices",
  "vendors",
  "community",
  "reviews",
  "events",
  "partner",
  "support",
]);

export type PublicLocation = {
  view: PublicView;
  page: number;
  postId: number | null;
  featuredSlot: number | null;
  vendorPostId: number | null;
  inquiryId: number | null;
};

type PublicUrlOptions = Partial<Omit<PublicLocation, "view">>;

const positiveInteger = (value: string | null) => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizedPath = (pathname: string) => {
  const trimmed = pathname.trim().replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return (trimmed || "/").toLowerCase();
};

export function parsePublicLocation(pathname: string, search: string): PublicLocation {
  const params = new URLSearchParams(search);
  const legacyBoard = params.get("board");
  const pathView = PATH_VIEWS.get(normalizedPath(pathname));
  const legacyView = legacyBoard === "gifs"
    ? "community"
    : legacyBoard === "notices" || legacyBoard === "reviews" || legacyBoard === "events" || legacyBoard === "community"
      ? legacyBoard
      : null;
  const view = pathView && pathView !== "home" ? pathView : legacyView ?? pathView ?? "home";
  return {
    view,
    page: positiveInteger(params.get("page")) ?? 1,
    postId: positiveInteger(params.get("post")),
    featuredSlot: positiveInteger(params.get("featured")),
    vendorPostId: positiveInteger(params.get("vendorPost")),
    inquiryId: positiveInteger(params.get("inquiry")),
  };
}

export function buildPublicUrl(view: PublicView, options: PublicUrlOptions = {}) {
  const params = new URLSearchParams();
  if (PAGINATED_PUBLIC_VIEWS.has(view)) params.set("page", String(Math.max(1, options.page ?? 1)));
  if (options.postId) params.set("post", String(options.postId));
  if (view === "vendors" && options.featuredSlot) params.set("featured", String(options.featuredSlot));
  if (view === "vendors" && options.vendorPostId) params.set("vendorPost", String(options.vendorPostId));
  if ((view === "support" || view === "partner") && options.inquiryId) params.set("inquiry", String(options.inquiryId));
  const query = params.toString();
  return `${PUBLIC_VIEW_PATHS[view]}${query ? `?${query}` : ""}`;
}
