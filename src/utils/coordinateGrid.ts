export interface CoordinatePoint {
  x: number;
  y: number;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface QuadCoordinates {
  topLeft: CoordinatePoint;
  topRight: CoordinatePoint;
  bottomLeft: CoordinatePoint;
  bottomRight: CoordinatePoint;
}

export interface CoordinateGridPoint {
  id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  normX: number; // 0..1 within current region
  normY: number; // 0..1 within current region
}

export interface Sector {
  id: number;
  row: number;
  col: number;
  box: BoundingBox;
  centerX: number;
  centerY: number;
}

export function generateSectors(
  region: BoundingBox,
  cols: number = 4,
  rows: number = 4
): Sector[] {
  const sectors: Sector[] = [];
  const colWidth = region.width / cols;
  const rowHeight = region.height / rows;

  let id = 1;
  for (let r = 0; r < rows; r++) {
    const minY = Math.round(region.minY + r * rowHeight);
    const maxY = r === rows - 1 ? region.maxY : Math.round(region.minY + (r + 1) * rowHeight);
    for (let c = 0; c < cols; c++) {
      const minX = Math.round(region.minX + c * colWidth);
      const maxX = c === cols - 1 ? region.maxX : Math.round(region.minX + (c + 1) * colWidth);
      const width = maxX - minX;
      const height = maxY - minY;
      sectors.push({
        id,
        row: r,
        col: c,
        box: { minX, minY, maxX, maxY, width, height },
        centerX: Math.round(minX + width / 2),
        centerY: Math.round(minY + height / 2),
      });
      id++;
    }
  }
  return sectors;
}

export interface NearestPointResult {
  hit: boolean;
  point: CoordinateGridPoint;
  distancePx: number;
}

export interface ZoomStepPlan {
  depth: number;
  action: 'capture_screen_with_grid' | 'zoom_coordinate_region' | 'move_mouse_to_coordinate';
  region: BoundingBox;
  gridCols: number;
  gridRows: number;
  gridSpacingX: number;
  gridSpacingY: number;
  magnification: number;
  nearestPoint: CoordinateGridPoint;
  distanceToTargetPx: number;
  enclosingQuad?: QuadCoordinates;
  finalMove?: {
    x: number;
    y: number;
    matchedPointId: string;
    residualErrorPx: number;
  };
}

export interface SimulatedDesktopTarget {
  id: string;
  label: string;
  category: string;
  x: number;
  y: number;
  width: number;
  height: number;
  description: string;
}

export const DEFAULT_SCREEN_WIDTH = 1920;
export const DEFAULT_SCREEN_HEIGHT = 1080;

export const SIMULATED_DESKTOP_TARGETS: SimulatedDesktopTarget[] = [
  {
    id: 'deploy-btn',
    label: 'Confirm Production Deploy',
    category: 'Primary Control',
    x: 1582,
    y: 864,
    width: 196,
    height: 44,
    description: 'Release confirmation button in the bottom-right deployment drawer',
  },
  {
    id: 'terminal-prompt',
    label: 'SSH Terminal Input Line',
    category: 'Developer Tool',
    x: 418,
    y: 742,
    width: 240,
    height: 36,
    description: 'Command input prompt inside the bottom-left terminal window',
  },
  {
    id: 'audio-gain-knob',
    label: 'Master Gain +3.5dB Node',
    category: 'Media Control',
    x: 1126,
    y: 318,
    width: 48,
    height: 48,
    description: 'Fine audio gain node on the studio telemetry mixer curve',
  },
  {
    id: 'security-key-toggle',
    label: 'Hardware Key Auth Switch',
    category: 'System Security',
    x: 1648,
    y: 214,
    width: 64,
    height: 32,
    description: 'FIDO2 hardware security key toggle in top-right inspector panel',
  },
  {
    id: 'branch-selector',
    label: 'Git Branch Dropdown (main)',
    category: 'IDE Navigation',
    x: 274,
    y: 126,
    width: 152,
    height: 34,
    description: 'Repository branch switcher in the upper-left code editor toolbar',
  },
  {
    id: 'Export-csv-icon',
    label: 'Export Telemetry Snapshot',
    category: 'Data Action',
    x: 946,
    y: 588,
    width: 140,
    height: 38,
    description: 'Export button in the center analytics table header',
  },
];

export function createFullScreenBox(
  screenWidth: number = DEFAULT_SCREEN_WIDTH,
  screenHeight: number = DEFAULT_SCREEN_HEIGHT
): BoundingBox {
  return {
    minX: 0,
    minY: 0,
    maxX: screenWidth,
    maxY: screenHeight,
    width: screenWidth,
    height: screenHeight,
  };
}

/**
 * Generates an evenly spaced grid of coordinate points across a given screen region.
 * Points are placed with an inset of half a cell or edge-to-edge so every sub-region is bounded by 4 points.
 */
export function generateCoordinateGrid(
  region: BoundingBox,
  cols: number = 6,
  rows: number = 6
): CoordinateGridPoint[] {
  const safeCols = Math.max(2, Math.min(20, Math.round(cols)));
  const safeRows = Math.max(2, Math.min(20, Math.round(rows)));
  const points: CoordinateGridPoint[] = [];

  for (let r = 0; r < safeRows; r++) {
    const normY = safeRows === 1 ? 0.5 : r / (safeRows - 1);
    const y = Math.round(region.minY + normY * region.height);

    for (let c = 0; c < safeCols; c++) {
      const normX = safeCols === 1 ? 0.5 : c / (safeCols - 1);
      const x = Math.round(region.minX + normX * region.width);
      points.push({
        id: `R${r + 1}C${c + 1}`,
        row: r,
        col: c,
        x,
        y,
        normX,
        normY,
      });
    }
  }

  return points;
}

/**
 * Computes a clamped, valid bounding box from 4 coordinates forming a square/quad around a target.
 */
export function computeQuadBoundingBox(
  quad: QuadCoordinates,
  screenWidth: number = DEFAULT_SCREEN_WIDTH,
  screenHeight: number = DEFAULT_SCREEN_HEIGHT,
  minDimensionPx: number = 24
): BoundingBox {
  const xs = [quad.topLeft.x, quad.topRight.x, quad.bottomLeft.x, quad.bottomRight.x];
  const ys = [quad.topLeft.y, quad.topRight.y, quad.bottomLeft.y, quad.bottomRight.y];

  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);

  if (maxX - minX < minDimensionPx) {
    const centerX = (minX + maxX) / 2;
    minX = centerX - minDimensionPx / 2;
    maxX = centerX + minDimensionPx / 2;
  }

  if (maxY - minY < minDimensionPx) {
    const centerY = (minY + maxY) / 2;
    minY = centerY - minDimensionPx / 2;
    maxY = centerY + minDimensionPx / 2;
  }

  minX = Math.max(0, Math.min(screenWidth - minDimensionPx, Math.round(minX)));
  maxX = Math.min(screenWidth, Math.max(minX + minDimensionPx, Math.round(maxX)));
  minY = Math.max(0, Math.min(screenHeight - minDimensionPx, Math.round(minY)));
  maxY = Math.min(screenHeight, Math.max(minY + minDimensionPx, Math.round(maxY)));

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Finds the closest coordinate grid point to a target (x, y) and checks whether it is within tolerance.
 */
export function findNearestGridPoint(
  gridPoints: CoordinateGridPoint[],
  targetX: number,
  targetY: number,
  tolerancePx: number = 14
): NearestPointResult {
  if (gridPoints.length === 0) {
    throw new Error('gridPoints array must not be empty');
  }

  let bestPoint = gridPoints[0];
  let bestDist = Math.hypot(bestPoint.x - targetX, bestPoint.y - targetY);

  for (let i = 1; i < gridPoints.length; i++) {
    const pt = gridPoints[i];
    const dist = Math.hypot(pt.x - targetX, pt.y - targetY);
    if (dist < bestDist) {
      bestDist = dist;
      bestPoint = pt;
    }
  }

  return {
    hit: bestDist <= tolerancePx,
    point: bestPoint,
    distancePx: Number(bestDist.toFixed(2)),
  };
}

/**
 * Given a grid of points and a target (x, y), returns the 4 coordinate points that form
 * the enclosing square/cell around the target location.
 * If the target lies very close to a grid line, expands by 1 cell around the nearest cell so the target is comfortably framed.
 */
export function findEnclosingQuad(
  gridPoints: CoordinateGridPoint[],
  cols: number,
  rows: number,
  targetX: number,
  targetY: number
): QuadCoordinates {
  const pointAt = (r: number, c: number): CoordinateGridPoint => {
    const clampedR = Math.max(0, Math.min(rows - 1, r));
    const clampedC = Math.max(0, Math.min(cols - 1, c));
    return gridPoints[clampedR * cols + clampedC];
  };

  // Find column interval containing targetX
  let c0 = 0;
  for (let c = 0; c < cols - 1; c++) {
    const leftX = pointAt(0, c).x;
    const rightX = pointAt(0, c + 1).x;
    if (targetX >= leftX && targetX <= rightX) {
      c0 = c;
      break;
    }
    if (targetX > rightX) {
      c0 = c;
    }
  }

  // Find row interval containing targetY
  let r0 = 0;
  for (let r = 0; r < rows - 1; r++) {
    const topY = pointAt(r, 0).y;
    const bottomY = pointAt(r + 1, 0).y;
    if (targetY >= topY && targetY <= bottomY) {
      r0 = r;
      break;
    }
    if (targetY > bottomY) {
      r0 = r;
    }
  }

  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);

  const tl = pointAt(r0, c0);
  const tr = pointAt(r0, c1);
  const bl = pointAt(r1, c0);
  const br = pointAt(r1, c1);

  return {
    topLeft: { x: tl.x, y: tl.y },
    topRight: { x: tr.x, y: tr.y },
    bottomLeft: { x: bl.x, y: bl.y },
    bottomRight: { x: br.x, y: br.y },
  };
}

/**
 * Plans the complete recursive 4-coordinate grid zoom sequence from full screen (Depth 0)
 * until a grid coordinate point lands within `tolerancePx` of `(targetX, targetY)`,
 * finishing with `move_mouse_to_coordinate`.
 */
export function planRecursiveZoomSequence(
  targetX: number,
  targetY: number,
  screenWidth: number = DEFAULT_SCREEN_WIDTH,
  screenHeight: number = DEFAULT_SCREEN_HEIGHT,
  cols: number = 6,
  rows: number = 6,
  tolerancePx: number = 12,
  maxDepth: number = 4
): ZoomStepPlan[] {
  const clampedTargetX = Math.max(0, Math.min(screenWidth, Math.round(targetX)));
  const clampedTargetY = Math.max(0, Math.min(screenHeight, Math.round(targetY)));

  const steps: ZoomStepPlan[] = [];
  let currentRegion = createFullScreenBox(screenWidth, screenHeight);

  for (let depth = 0; depth <= maxDepth; depth++) {
    const grid = generateCoordinateGrid(currentRegion, cols, rows);
    const nearest = findNearestGridPoint(grid, clampedTargetX, clampedTargetY, tolerancePx);
    const spacingX = Number((currentRegion.width / Math.max(1, cols - 1)).toFixed(1));
    const spacingY = Number((currentRegion.height / Math.max(1, rows - 1)).toFixed(1));
    const magnification = Number((screenWidth / Math.max(1, currentRegion.width)).toFixed(2));

    if (nearest.hit || depth === maxDepth) {
      steps.push({
        depth,
        action: 'move_mouse_to_coordinate',
        region: currentRegion,
        gridCols: cols,
        gridRows: rows,
        gridSpacingX: spacingX,
        gridSpacingY: spacingY,
        magnification,
        nearestPoint: nearest.point,
        distanceToTargetPx: nearest.distancePx,
        finalMove: {
          x: nearest.point.x,
          y: nearest.point.y,
          matchedPointId: nearest.point.id,
          residualErrorPx: nearest.distancePx,
        },
      });
      break;
    }

    const quad = findEnclosingQuad(grid, cols, rows, clampedTargetX, clampedTargetY);
    steps.push({
      depth,
      action: depth === 0 ? 'capture_screen_with_grid' : 'zoom_coordinate_region',
      region: currentRegion,
      gridCols: cols,
      gridRows: rows,
      gridSpacingX: spacingX,
      gridSpacingY: spacingY,
      magnification,
      nearestPoint: nearest.point,
      distanceToTargetPx: nearest.distancePx,
      enclosingQuad: quad,
    });

    currentRegion = computeQuadBoundingBox(quad, screenWidth, screenHeight, 16);
  }

  return steps;
}
