import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFullScreenBox,
  generateCoordinateGrid,
  computeQuadBoundingBox,
  findNearestGridPoint,
  findEnclosingQuad,
  planRecursiveZoomSequence,
} from './coordinateGrid';

test('generateCoordinateGrid creates cols * rows evenly spaced screen coordinates', () => {
  const fullBox = createFullScreenBox(1920, 1080);
  const grid = generateCoordinateGrid(fullBox, 5, 5);
  assert.equal(grid.length, 25);
  assert.equal(grid[0].x, 0);
  assert.equal(grid[0].y, 0);
  assert.equal(grid[0].id, 'R1C1');
  assert.equal(grid[24].x, 1920);
  assert.equal(grid[24].y, 1080);
  assert.equal(grid[24].id, 'R5C5');
  // Center point (R3C3, index 12) should be at (960, 540)
  assert.equal(grid[12].x, 960);
  assert.equal(grid[12].y, 540);
});

test('computeQuadBoundingBox derives accurate bounding box from 4 square coordinates', () => {
  const box = computeQuadBoundingBox(
    {
      topLeft: { x: 400, y: 200 },
      topRight: { x: 800, y: 200 },
      bottomLeft: { x: 400, y: 500 },
      bottomRight: { x: 800, y: 500 },
    },
    1920,
    1080
  );
  assert.equal(box.minX, 400);
  assert.equal(box.maxX, 800);
  assert.equal(box.minY, 200);
  assert.equal(box.maxY, 500);
  assert.equal(box.width, 400);
  assert.equal(box.height, 300);
});

test('findNearestGridPoint detects direct hit when target aligns with a coordinate point', () => {
  const fullBox = createFullScreenBox(1920, 1080);
  const grid = generateCoordinateGrid(fullBox, 5, 5);
  const hitResult = findNearestGridPoint(grid, 963, 542, 10);
  assert.equal(hitResult.hit, true);
  assert.equal(hitResult.point.id, 'R3C3');
  assert.ok(hitResult.distancePx <= 5);

  const missResult = findNearestGridPoint(grid, 710, 390, 10);
  assert.equal(missResult.hit, false);
});

test('findEnclosingQuad returns 4 coordinates forming a square around target location', () => {
  const fullBox = createFullScreenBox(1000, 1000);
  const grid = generateCoordinateGrid(fullBox, 6, 6); // steps of 200px: 0, 200, 400, 600, 800, 1000
  const quad = findEnclosingQuad(grid, 6, 6, 525, 340);
  assert.deepEqual(quad.topLeft, { x: 400, y: 200 });
  assert.deepEqual(quad.topRight, { x: 600, y: 200 });
  assert.deepEqual(quad.bottomLeft, { x: 400, y: 400 });
  assert.deepEqual(quad.bottomRight, { x: 600, y: 400 });
});

test('planRecursiveZoomSequence zooms in via 4-point squares until target is locked', () => {
  // Choose an off-grid target coordinate (1582, 864) on a 1920x1080 screen
  const steps = planRecursiveZoomSequence(1582, 864, 1920, 1080, 6, 6, 8, 4);
  assert.ok(steps.length >= 2, 'Expected multiple zoom steps for off-grid target');
  assert.equal(steps[0].depth, 0);
  assert.ok(steps[0].enclosingQuad, 'First step should provide 4 enclosing coordinates');

  const finalStep = steps[steps.length - 1];
  assert.equal(finalStep.action, 'move_mouse_to_coordinate');
  assert.ok(finalStep.finalMove, 'Final step should include mouse movement coordinates');
  assert.ok(
    Math.hypot(finalStep.finalMove.x - 1582, finalStep.finalMove.y - 864) <= 8,
    `Expected final mouse coordinate within 8px of target, got error ${finalStep.finalMove.residualErrorPx}px`
  );
});
