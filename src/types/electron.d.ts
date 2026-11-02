export {};

declare global {
  interface ScreenCapture {
    dataUrl: string;
    /** Logical (DIP) screen size — all agent coordinates use this space */
    width: number;
    height: number;
    scaleFactor: number;
    imageWidth: number;
    imageHeight: number;
  }

  interface Window {
    electronAPI?: {
      isElectron: boolean;
      platform: string;
      captureScreen: () => Promise<ScreenCapture>;
      moveMouse: (x: number, y: number) => Promise<{ ok: boolean; x: number; y: number; error: string | null }>;
      clickMouse: (button?: 'left' | 'right', double?: boolean) => Promise<{ ok: boolean; error: string | null }>;
      getCursorPoint: () => Promise<{ x: number; y: number }>;
      getWindowsUITree: () => Promise<{ ok: boolean; tree?: string; error?: string }>;
      setPinned: (pinned: boolean) => Promise<boolean>;
    };
  }
}
