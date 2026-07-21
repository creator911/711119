export function visiblePageNumbers(activePage: number, totalPages: number, maximum = 5) {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  const safeActive = Math.min(safeTotal, Math.max(1, Math.floor(activePage)));
  const visibleCount = Math.min(Math.max(1, Math.floor(maximum)), safeTotal);
  const start = Math.max(1, Math.min(safeActive - Math.floor(visibleCount / 2), safeTotal - visibleCount + 1));
  return Array.from({ length: visibleCount }, (_, index) => start + index);
}
