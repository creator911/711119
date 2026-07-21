export type CoverCropGeometry = {
  sourceWidth: number;
  sourceHeight: number;
  maxSourceX: number;
  maxSourceY: number;
};

export type CoverDragInput = {
  imageWidth: number;
  imageHeight: number;
  targetRatio: number;
  zoom: number;
  horizontal: number;
  vertical: number;
  deltaX: number;
  deltaY: number;
  viewportWidth: number;
  viewportHeight: number;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const roundPosition = (value: number) => Math.round(value * 100) / 100;

export function getCoverCropGeometry(imageWidth: number, imageHeight: number, targetRatio: number, zoom: number): CoverCropGeometry | null {
  if (imageWidth <= 0 || imageHeight <= 0 || targetRatio <= 0 || zoom <= 0) return null;
  const imageRatio = imageWidth / imageHeight;
  const baseWidth = imageRatio > targetRatio ? imageHeight * targetRatio : imageWidth;
  const baseHeight = imageRatio > targetRatio ? imageHeight : imageWidth / targetRatio;
  const sourceWidth = baseWidth / zoom;
  const sourceHeight = baseHeight / zoom;
  return {
    sourceWidth,
    sourceHeight,
    maxSourceX: Math.max(0, imageWidth - sourceWidth),
    maxSourceY: Math.max(0, imageHeight - sourceHeight),
  };
}

function moveAxis(startPosition: number, delta: number, sourceSize: number, maxSourceOffset: number, viewportSize: number) {
  const normalizedStart = clamp(startPosition, 0, 100);
  if (maxSourceOffset <= 0 || viewportSize <= 0) return normalizedStart;
  const startSourceOffset = maxSourceOffset * normalizedStart / 100;
  const nextSourceOffset = clamp(startSourceOffset - delta * sourceSize / viewportSize, 0, maxSourceOffset);
  return roundPosition(nextSourceOffset / maxSourceOffset * 100);
}

export function moveCoverPositionByDrag(input: CoverDragInput) {
  const geometry = getCoverCropGeometry(input.imageWidth, input.imageHeight, input.targetRatio, input.zoom);
  if (!geometry) return { horizontal: clamp(input.horizontal, 0, 100), vertical: clamp(input.vertical, 0, 100) };
  return {
    horizontal: moveAxis(input.horizontal, input.deltaX, geometry.sourceWidth, geometry.maxSourceX, input.viewportWidth),
    vertical: moveAxis(input.vertical, input.deltaY, geometry.sourceHeight, geometry.maxSourceY, input.viewportHeight),
  };
}
