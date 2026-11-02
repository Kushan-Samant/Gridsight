/**
 * ScreenAgent — the hidden "hands and eyes" of the assistant.
 *
 * Executes Gemini Live tool calls against the REAL desktop:
 *  - captures the primary screen at native resolution (via Electron)
 *  - annotates it with a labeled coordinate grid
 *  - recursively crops/zooms into 4-point regions with finer grids
 *  - moves / clicks the real OS mouse
 *
 * None of this is shown in the chat UI — the UI only receives friendly
 * activity events ("Looking at your screen", "Moved cursor to …").
 */
import {
  BoundingBox,
  CoordinatePoint,
  QuadCoordinates,
  Sector,
  computeQuadBoundingBox,
  createFullScreenBox,
  generateSectors,
} from '../utils/coordinateGrid';

export type AgentActivity =
  | { kind: 'look'; label: string; image?: string }
  | { kind: 'zoom'; label: string; image?: string }
  | { kind: 'move'; label: string; image?: string }
  | { kind: 'click'; label: string; image?: string }
  | { kind: 'error'; label: string };

export interface ToolResult {
  response: Record<string, unknown>;
  /** Annotated JPEG data URL streamed to the model as the latest "video" frame */
  imageBase64?: string;
}

interface Frame {
  image: HTMLImageElement;
  screenWidth: number;
  screenHeight: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode screen capture'));
    img.src = src;
  });
}

export class ScreenAgent {
  private frame: Frame | null = null;
  private region: BoundingBox = createFullScreenBox();
  private depth = 0;
  private sectors: Sector[] = [];
  private canvas = document.createElement('canvas');

  constructor(private readonly onActivity: (activity: AgentActivity) => void) {}

  static get isAvailable(): boolean {
    return Boolean(window.electronAPI?.captureScreen);
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!ScreenAgent.isAvailable) {
      this.onActivity({ kind: 'error', label: 'Screen control needs the desktop app' });
      return {
        response: {
          error: 'Screen and mouse control are only available in the GridSight desktop app. Tell the user briefly.',
        },
      };
    }

    try {
      switch (name) {
        case 'capture_screen_with_grid':
          return await this.captureScreen();
        case 'zoom_into_sector':
          return await this.zoomSector(args);
        case 'click_sector':
          return await this.clickSector(args);
        case 'zoom_coordinate_region':
          return await this.zoomLegacy(args);
        case 'move_mouse_to_coordinate':
          return await this.moveMouse(args);
        case 'click_mouse':
          return await this.click(args);
        case 'reset_zoom_grid':
          return await this.reset();
        default:
          return { response: { error: `Unknown tool: ${name}` } };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onActivity({ kind: 'error', label: 'Something went wrong on screen' });
      return { response: { error: message } };
    }
  }

  /* ---------------------------- tools ---------------------------- */

  private async captureScreen(): Promise<ToolResult> {
    await this.refreshFrame();
    this.region = createFullScreenBox(this.frame!.screenWidth, this.frame!.screenHeight);
    this.depth = 0;
    const res = await this.viewResult(
      'Image is divided into 16 grid boxes (1 to 16). Find which box contains your target icon. Call zoom_into_sector(sectorNumber) to zoom into that box and make 16 sub-boxes. Or if the icon already fills the box, call click_sector(sectorNumber).'
    );
    this.onActivity({ kind: 'look', label: 'Looking at your screen', image: res.imageBase64 });
    return res;
  }

  private async zoomSector(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.frame) await this.refreshFrame();
    const sectorNum = Math.round(Number(args.sectorNumber) || 1);
    const targetSector = this.sectors.find((s) => s.id === sectorNum) || this.sectors[0];

    if (!targetSector) {
      return { response: { error: `Sector ${sectorNum} not found` } };
    }

    console.log(`[ScreenAgent] zoomSector: sector=${sectorNum}, newRegion=`, targetSector.box, `depth=${this.depth + 1}`);
    this.region = { ...targetSector.box };
    this.depth += 1;

    const label = String(args.targetLabel || `Box ${sectorNum}`);
    const res = await this.viewResult(
      `Now zoomed into Box ${sectorNum}. 16 smaller sub-grid boxes (1 to 16) are shown. If the target icon is in one of these sub-boxes, call click_sector(sectorNumber) to click it, or call zoom_into_sector(sectorNumber) to zoom in even closer.`
    );
    this.onActivity({ kind: 'zoom', label: `Zooming in on ${label}`, image: res.imageBase64 });
    return res;
  }

  private async clickSector(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.frame) await this.refreshFrame();
    const sectorNum = Math.round(Number(args.sectorNumber) || 1);
    const targetSector = this.sectors.find((s) => s.id === sectorNum) || this.sectors[0];

    if (!targetSector) {
      return { response: { error: `Sector ${sectorNum} not found` } };
    }

    const { centerX, centerY } = targetSector;
    const label = String(args.targetLabel || `Quadrant ${sectorNum}`);
    const double = Boolean(args.doubleClick);
    const button = args.button === 'right' ? 'right' : 'left';

    console.log(`[ScreenAgent] clickSector: sector=${sectorNum}, targetCenter=(${centerX}, ${centerY}), depth=${this.depth}, region=`, this.region);

    const moveRes = await window.electronAPI!.moveMouse(centerX, centerY);
    if (!moveRes.ok) {
      this.onActivity({ kind: 'error', label: `Couldn't move mouse to quadrant` });
      return { response: { status: 'failed', error: moveRes.error } };
    }

    await window.electronAPI!.clickMouse(button, double);
    const view = await this.render();

    this.onActivity({
      kind: 'click',
      label: `${double ? 'Double-clicked' : 'Clicked'} ${label}`,
      image: view.imageBase64,
    });

    // Reset back to full screen after click so next action starts with a full fresh view
    this.region = createFullScreenBox(this.frame!.screenWidth, this.frame!.screenHeight);
    this.depth = 0;
    this.frame = null;

    return {
      response: {
        status: double ? 'double_clicked' : 'clicked',
        sector: sectorNum,
        x: centerX,
        y: centerY,
      },
      imageBase64: view.imageBase64,
    };
  }

  private async zoomLegacy(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.frame) await this.refreshFrame();
    const { screenWidth, screenHeight } = this.frame!;
    const n = (key: string, fallback: number) => {
      const v = Number(args[key]);
      return Number.isFinite(v) ? v : fallback;
    };

    const quad: QuadCoordinates = {
      topLeft: { x: n('topLeftX', 0), y: n('topLeftY', 0) },
      topRight: { x: n('topRightX', screenWidth), y: n('topRightY', 0) },
      bottomLeft: { x: n('bottomLeftX', 0), y: n('bottomLeftY', screenHeight) },
      bottomRight: { x: n('bottomRightX', screenWidth), y: n('bottomRightY', screenHeight) },
    };

    this.region = computeQuadBoundingBox(quad, screenWidth, screenHeight, 24);
    this.depth += 1;

    const label = String(args.targetLabel || 'the target');
    const res = await this.viewResult('Zoomed-in view.');
    this.onActivity({ kind: 'zoom', label: `Zooming in on ${label}`, image: res.imageBase64 });
    return res;
  }

  private async moveMouse(args: Record<string, unknown>): Promise<ToolResult> {
    const sw = this.frame?.screenWidth ?? window.screen.width;
    const sh = this.frame?.screenHeight ?? window.screen.height;
    const x = clamp(Math.round(Number(args.x) || 0), 0, sw - 1);
    const y = clamp(Math.round(Number(args.y) || 0), 0, sh - 1);

    const result = await window.electronAPI!.moveMouse(x, y);
    const label = String(args.targetLabel || 'the target');

    if (!result.ok) {
      this.onActivity({ kind: 'error', label: `Couldn't move the cursor` });
      return { response: { status: 'failed', error: result.error } };
    }

    const view = this.frame ? await this.render() : null;
    const shouldClick = Boolean(args.click);
    const shouldDoubleClick = Boolean(args.doubleClick);

    if (shouldDoubleClick) {
      await window.electronAPI!.clickMouse('left', true);
      this.onActivity({ kind: 'click', label: `Double-clicked ${label}`, image: view?.imageBase64 });
    } else if (shouldClick) {
      await window.electronAPI!.clickMouse('left', false);
      this.onActivity({ kind: 'click', label: `Clicked ${label}`, image: view?.imageBase64 });
    } else {
      this.onActivity({ kind: 'move', label: `Moved cursor to ${label}`, image: view?.imageBase64 });
    }

    return {
      response: {
        status: shouldDoubleClick ? 'double_clicked' : shouldClick ? 'clicked' : 'moved',
        x: result.x,
        y: result.y,
      },
      imageBase64: view?.imageBase64,
    };
  }

  private async click(args: Record<string, unknown>): Promise<ToolResult> {
    const button = args.button === 'right' ? 'right' : 'left';
    const double = Boolean(args.double);
    const label = String(args.targetLabel || 'it');

    const result = await window.electronAPI!.clickMouse(button, double);
    if (!result.ok) {
      this.onActivity({ kind: 'error', label: `Couldn't click` });
      return { response: { status: 'failed', error: result.error } };
    }

    this.onActivity({
      kind: 'click',
      label: `${double ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : 'Clicked'} ${label}`,
    });

    this.frame = null;
    this.depth = 0;
    return { response: { status: 'clicked', button, double } };
  }

  private async reset(): Promise<ToolResult> {
    if (!this.frame) await this.refreshFrame();
    this.region = createFullScreenBox(this.frame!.screenWidth, this.frame!.screenHeight);
    this.depth = 0;
    return this.viewResult('Back to the full screen view.');
  }

  /* -------------------------- rendering -------------------------- */

  private async refreshFrame() {
    const capture = await window.electronAPI!.captureScreen();
    const image = await loadImage(capture.dataUrl);
    this.frame = { image, screenWidth: capture.width, screenHeight: capture.height };
  }

  private async viewResult(instruction: string): Promise<ToolResult> {
    const view = await this.render();
    return {
      imageBase64: view.imageBase64,
      response: {
        depth: this.depth,
        region: this.region,
        screen: { width: this.frame!.screenWidth, height: this.frame!.screenHeight },
        mouse: view.cursor,
        sectors: this.sectors.map((s) => ({
          id: s.id,
          centerX: s.centerX,
          centerY: s.centerY,
          box: s.box,
        })),
        instruction,
      },
    };
  }

  private async render(): Promise<{
    imageBase64: string;
    sectors: Sector[];
    cursor: CoordinatePoint | null;
  }> {
    const frame = this.frame!;
    const region = this.region;
    const aspect = region.width / Math.max(1, region.height);

    // Canvas size
    const longSide = this.depth === 0 ? 1536 : 1280;
    const cw = aspect >= 1 ? longSide : Math.round(longSide * aspect);
    const ch = aspect >= 1 ? Math.round(longSide / aspect) : longSide;

    // Slices into a crisp 4x4 quadrant grid (16 sectors)
    const cols = 4;
    const rows = 4;
    this.sectors = generateSectors(region, cols, rows);
    const sectors = this.sectors;

    const canvas = this.canvas;
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Screen image
    const sx = frame.image.naturalWidth / frame.screenWidth;
    const sy = frame.image.naturalHeight / frame.screenHeight;
    ctx.drawImage(
      frame.image,
      region.minX * sx,
      region.minY * sy,
      region.width * sx,
      region.height * sy,
      0,
      0,
      cw,
      ch
    );

    const toX = (x: number) => ((x - region.minX) / Math.max(1, region.width)) * cw;
    const toY = (y: number) => ((y - region.minY) / Math.max(1, region.height)) * ch;

    // Draw quadrant bounding lines with neon glow and crisp dashed line
    ctx.save();
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 240, 255, 0.7)';
    ctx.shadowBlur = 6;
    ctx.setLineDash([8, 6]);

    for (let c = 1; c < cols; c++) {
      const x = Math.round((c / cols) * cw) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ch);
      ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      const y = Math.round((r / rows) * ch) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cw, y);
      ctx.stroke();
    }
    ctx.restore();

    // Render quadrant badges with bold numbers right in the center of each box
    ctx.save();
    for (const sec of sectors) {
      const bx = toX(sec.box.minX);
      const by = toY(sec.box.minY);
      const bw = toX(sec.box.maxX) - bx;
      const bh = toY(sec.box.maxY) - by;
      const cx = bx + bw / 2;
      const cy = by + bh / 2;

      // Center badge
      const tagText = `${sec.id}`;
      const badgeW = Math.max(34, Math.min(52, Math.round(bw * 0.22)));
      const badgeH = Math.max(26, Math.min(38, Math.round(bh * 0.22)));
      const badgeX = cx - badgeW / 2;
      const badgeY = cy - badgeH / 2;

      // Dark translucent badge background with neon border
      ctx.fillStyle = 'rgba(10, 14, 26, 0.88)';
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
      ctx.fill();

      ctx.strokeStyle = '#00f0ff';
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Bold number
      ctx.font = `900 ${Math.round(badgeH * 0.65)}px "JetBrains Mono", system-ui, monospace`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagText, cx, cy + 1);

      // Subtle crosshair tick at exact center
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy);
      ctx.lineTo(cx + 5, cy);
      ctx.moveTo(cx, cy - 5);
      ctx.lineTo(cx, cy + 5);
      ctx.stroke();
    }
    ctx.restore();

    // Current mouse position
    let cursor: CoordinatePoint | null = null;
    try {
      cursor = await window.electronAPI!.getCursorPoint();
    } catch {
      cursor = null;
    }
    if (cursor) {
      const mx = toX(cursor.x);
      const my = toY(cursor.y);
      if (mx >= -20 && mx <= cw + 20 && my >= -20 && my <= ch + 20) {
        ctx.save();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#00e676';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 5;
        ctx.beginPath();
        ctx.arc(mx, my, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    return { imageBase64: canvas.toDataURL('image/jpeg', 0.88), sectors, cursor };
  }
}
