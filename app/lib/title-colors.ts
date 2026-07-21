export const TITLE_COLOR_OPTIONS = [
  { label: "기본", value: "" },
  { label: "검정", value: "#111111" },
  { label: "빨강", value: "#ef4444" },
  { label: "파랑", value: "#2563eb" },
  { label: "초록", value: "#16a34a" },
  { label: "보라", value: "#7c3aed" },
  { label: "주황", value: "#f97316" },
  { label: "회색", value: "#6b7280" },
] as const;

export type TitleColor = typeof TITLE_COLOR_OPTIONS[number]["value"];

const allowedTitleColors = new Set<string>(TITLE_COLOR_OPTIONS.map((option) => option.value));

export function normalizeTitleColor(value: unknown): TitleColor | null {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return allowedTitleColors.has(normalized) ? normalized as TitleColor : null;
}
