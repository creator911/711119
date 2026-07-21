const EDGE_TOLERANCE = 2;

export function horizontalScrollAvailability(scrollLeft: number, clientWidth: number, scrollWidth: number) {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  const currentScrollLeft = Math.min(Math.max(0, scrollLeft), maxScrollLeft);

  return {
    canScrollLeft: currentScrollLeft > EDGE_TOLERANCE,
    canScrollRight: currentScrollLeft < maxScrollLeft - EDGE_TOLERANCE,
  };
}

export function horizontalScrollStep(clientWidth: number) {
  return Math.max(180, Math.round(clientWidth * 0.82));
}

export function horizontalScrollTarget(
  direction: -1 | 1,
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  items: Array<{ left: number; width: number }>,
) {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  const currentScrollLeft = Math.min(Math.max(0, scrollLeft), maxScrollLeft);

  if (direction === 1) {
    const rightEdge = currentScrollLeft + clientWidth;
    const firstClippedItem = items.find((item) => item.left > currentScrollLeft + EDGE_TOLERANCE && item.left + item.width > rightEdge + EDGE_TOLERANCE);
    return Math.min(firstClippedItem?.left ?? maxScrollLeft, maxScrollLeft);
  }

  const previousPage = Math.max(0, currentScrollLeft - horizontalScrollStep(clientWidth));
  const previousItem = [...items].reverse().find((item) => item.left <= previousPage + EDGE_TOLERANCE);
  return Math.max(0, previousItem?.left ?? 0);
}
