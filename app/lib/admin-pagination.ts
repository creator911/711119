export const ADMIN_PAGE_SIZES = [10, 100, 1000] as const;
export type AdminPageSize = (typeof ADMIN_PAGE_SIZES)[number];

export const DEFAULT_ADMIN_PAGE_SIZE: AdminPageSize = 10;
export const ADMIN_PAGE_GROUP_SIZE = 20;
export const MAX_ADMIN_MEMBER_BATCH_UPDATES = 50;

export function isAdminPageSize(value: number): value is AdminPageSize {
  return ADMIN_PAGE_SIZES.some((pageSize) => pageSize === value);
}

export function groupedAdminPageNumbers(activePage: number, totalPages: number, groupSize = ADMIN_PAGE_GROUP_SIZE) {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  const safeActive = Math.min(safeTotal, Math.max(1, Math.floor(activePage)));
  const safeGroupSize = Math.max(1, Math.floor(groupSize));
  const start = Math.floor((safeActive - 1) / safeGroupSize) * safeGroupSize + 1;
  const end = Math.min(safeTotal, start + safeGroupSize - 1);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
