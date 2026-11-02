/**
 * ScreenAgent — the hidden "hands and eyes" of the assistant.
 *
 * Executes Gemini Live tool calls against the REAL desktop.
 * None of this is shown in the chat UI — the UI only receives friendly
 * activity events ("Looking at your screen", "Moved cursor to …").
 */

export type AgentActivity =
  | { kind: 'look'; label: string; image?: string }
  | { kind: 'zoom'; label: string; image?: string }
  | { kind: 'move'; label: string; image?: string }
  | { kind: 'click'; label: string; image?: string }
  | { kind: 'error'; label: string }
  | { kind: 'tree'; label: string; };

export interface ToolResult {
  response: Record<string, unknown>;
  imageBase64?: string;
}

export class ScreenAgent {
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
        case 'capture_screen':
        case 'capture_screen_with_grid':
          return await this.captureScreen();
        case 'get_windows_ui_tree':
          return await this.getWindowsUiTree();
        case 'click_ui_element':
          return await this.clickUiElement(args);
        default:
          return { response: { status: 'unknown_tool', tool: name } };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onActivity({ kind: 'error', label: `Error: ${msg}` });
      return { response: { status: 'failed', error: msg } };
    }
  }

  private async captureScreen(): Promise<ToolResult> {
    const capture = await window.electronAPI!.captureScreen();
    this.onActivity({ kind: 'zoom', label: 'Looking at screen', image: capture.dataUrl });
    return {
      imageBase64: capture.dataUrl,
      response: { status: 'success', instruction: 'Screen captured.' }
    };
  }

  private async getWindowsUiTree(): Promise<ToolResult> {
    if (!window.electronAPI!.getWindowsUITree) {
      this.onActivity({ kind: 'error', label: `OS doesn't support getWindowsUITree` });
      return { response: { status: 'failed', error: 'UI Tree extraction not supported' } };
    }

    this.onActivity({ kind: 'tree', label: 'Extracting Windows UI tree' });
    const result = await window.electronAPI!.getWindowsUITree();

    if (!result.ok) {
      this.onActivity({ kind: 'error', label: `Couldn't extract UI tree` });
      return { response: { status: 'failed', error: result.error || 'Unknown error' } };
    }

    return { response: { status: 'success', tree: result.tree } };
  }

  private async clickUiElement(args: Record<string, unknown>): Promise<ToolResult> {
    const x = Math.round(Number(args.x) || 0);
    const y = Math.round(Number(args.y) || 0);
    const doubleClick = Boolean(args.doubleClick);
    const button = args.button === 'right' ? 'right' : 'left';
    const label = String(args.targetLabel || 'the element');

    const moveRes = await window.electronAPI!.moveMouse(x, y);
    if (!moveRes.ok) {
      this.onActivity({ kind: 'error', label: `Couldn't move mouse to (${x}, ${y})` });
      return { response: { status: 'failed', error: moveRes.error } };
    }

    await window.electronAPI!.clickMouse(button, doubleClick);

    // Take a small delay then capture screenshot to confirm
    await new Promise(r => setTimeout(r, 500));
    const capture = await window.electronAPI!.captureScreen();

    this.onActivity({
      kind: 'click',
      label: `${doubleClick ? 'Double-clicked' : 'Clicked'} ${label}`,
      image: capture.dataUrl,
    });

    return {
      response: {
        status: doubleClick ? 'double_clicked' : 'clicked',
        x,
        y,
      },
      imageBase64: capture.dataUrl,
    };
  }
}
