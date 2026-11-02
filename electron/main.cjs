/**
 * GridSight — Electron Main Process (electron/main.cjs)
 *
 * - Boots the local Gemini Live backend (server.ts) automatically if it isn't running
 * - Hosts the compact conversational chat window
 * - Provides native full-resolution screen capture (desktopCapturer)
 * - Provides real OS cursor movement + clicking
 *   (Windows: persistent PowerShell bridge to user32, macOS: JXA, Linux: xdotool)
 */
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, shell } = require('electron');
const path = require('path');
const http = require('http');
const { spawn, execFile, execFileSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const SERVER_URL = process.env.ELECTRON_START_URL || `http://localhost:${PORT}`;

app.setName('GridSight');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

let mainWindow = null;
let serverProcess = null;

/* ------------------------------------------------------------------ */
/* Backend server                                                      */
/* ------------------------------------------------------------------ */

function checkServerHealthy() {
  return new Promise((resolve) => {
    const req = http.get(`${SERVER_URL}/api/health`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).status === 'ok');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureBackendServer() {
  if (await checkServerHealthy()) return;

  serverProcess = spawn('node', ['--import', 'tsx', 'server.ts'], {
    cwd: ROOT_DIR,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code) => {
    console.log(`[server] exited with code ${code}`);
    serverProcess = null;
  });

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await checkServerHealthy()) return;
    if (!serverProcess) throw new Error('The backend server exited during startup. Check the terminal for errors.');
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Timed out waiting for the backend server to start.');
}

function stopBackendServer() {
  if (!serverProcess || serverProcess.pid == null) return;
  const pid = serverProcess.pid;
  serverProcess = null;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Already gone
  }
}

/* ------------------------------------------------------------------ */
/* Native mouse control                                                */
/* ------------------------------------------------------------------ */

// A single long-lived PowerShell process with user32 bindings compiled once,
// so each move/click takes a few milliseconds instead of ~1s.
const WIN_INPUT_TYPE = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GSInput { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo); }'`;

let psProc = null;
let psBuffer = '';
let psSeq = 0;
const psPending = new Map();

function getPowerShell() {
  if (psProc && psProc.exitCode === null && !psProc.killed) return psProc;

  psProc = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { windowsHide: true }
  );
  psBuffer = '';
  psProc.stdout.setEncoding('utf8');
  psProc.stdout.on('data', (chunk) => {
    psBuffer += chunk;
    let idx;
    while ((idx = psBuffer.indexOf('\n')) >= 0) {
      const line = psBuffer.slice(0, idx).trim();
      psBuffer = psBuffer.slice(idx + 1);
      const match = /^GSDONE (\d+)$/.exec(line);
      if (match && psPending.has(match[1])) {
        const done = psPending.get(match[1]);
        psPending.delete(match[1]);
        done(true);
      }
    }
  });
  psProc.stderr.on('data', (d) => console.warn('[mouse]', String(d).trim()));
  psProc.on('exit', () => {
    psProc = null;
    for (const [, done] of psPending) done(false);
    psPending.clear();
  });

  psProc.stdin.write(`${WIN_INPUT_TYPE}\n[GSInput]::SetProcessDPIAware() | Out-Null\n`);
  return psProc;
}

function runPowerShell(command, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const id = String(++psSeq);
    const timer = setTimeout(() => {
      psPending.delete(id);
      resolve(false);
    }, timeoutMs);
    psPending.set(id, (ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
    getPowerShell().stdin.write(`${command}; Write-Output "GSDONE ${id}"\n`);
  });
}

function execFileOk(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err) => resolve(err ? err.message : null));
  });
}

async function moveNativeCursor(x, y) {
  const safeX = Math.round(Number(x) || 0);
  const safeY = Math.round(Number(y) || 0);
  let error = null;

  if (process.platform === 'win32') {
    // Both screen capture and [System.Windows.Forms.Cursor]::Position use logical DIP coordinates (1536x864)
    const psCmd = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${safeX}, ${safeY})`;
    const ok = await runPowerShell(psCmd);
    if (!ok) error = 'Windows cursor bridge did not respond';
  } else if (process.platform === 'darwin') {
    error = await execFileOk('osascript', [
      '-l',
      'JavaScript',
      '-e',
      `ObjC.import('CoreGraphics'); $.CGWarpMouseCursorPosition({x: ${safeX}, y: ${safeY}});`,
    ]);
  } else {
    error = await execFileOk('xdotool', ['mousemove', String(safeX), String(safeY)]);
  }

  const actual = screen.getCursorScreenPoint();
  return { ok: !error, x: actual.x, y: actual.y, error };
}

async function clickNativeMouse(button = 'left', double = false) {
  if (process.platform === 'win32') {
    const [down, up] = button === 'right' ? [8, 16] : [2, 4];
    const clickOnce = `[GSInput]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); [GSInput]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`;
    const script = double
      ? `${clickOnce}; Start-Sleep -Milliseconds 80; ${clickOnce}`
      : clickOnce;
    const ok = await runPowerShell(script);
    return { ok, error: ok ? null : 'Windows click bridge did not respond' };
  }

  if (process.platform === 'linux') {
    const error = await execFileOk('xdotool', [
      'click',
      '--repeat',
      double ? '2' : '1',
      button === 'right' ? '3' : '1',
    ]);
    return { ok: !error, error };
  }

  return { ok: false, error: 'Clicking is currently supported on Windows and Linux only.' };
}

async function getWindowsUITree() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'UI Tree extraction is currently supported on Windows only.' };
  }

  const scriptPath = path.join(__dirname, 'GetForegroundUiTree.ps1');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, error: error.message || stderr });
      } else {
        resolve({ ok: true, tree: stdout.trim() });
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Screen capture                                                      */
/* ------------------------------------------------------------------ */

async function capturePrimaryScreen() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size; // DIP
  const scaleFactor = display.scaleFactor || 1;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source) throw new Error('No screen source available for capture');

  const image = source.thumbnail;
  const size = image.getSize();
  return {
    dataUrl: `data:image/jpeg;base64,${image.toJPEG(90).toString('base64')}`,
    width,
    height,
    scaleFactor,
    imageWidth: size.width,
    imageHeight: size.height,
  };
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#07080d;color:#8a90a2;font:500 13px system-ui,sans-serif;-webkit-app-region:drag}
.c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
.o{width:64px;height:64px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#c4b5fd,#7c3aed 45%,#1e3a8a 80%);
box-shadow:0 0 60px rgba(124,58,237,.55);animation:p 1.6s ease-in-out infinite}
@keyframes p{0%,100%{transform:scale(.92);opacity:.8}50%{transform:scale(1.05);opacity:1}}
</style></head><body><div class="c"><div class="o"></div><div>Waking up GridSight…</div></div></body></html>`;

function errorHtml(message) {
  const safe = String(message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#07080d;color:#e7e9f0;font:14px system-ui,sans-serif}
.c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;text-align:center}
h1{font-size:16px;margin:0;color:#fca5a5}p{color:#8a90a2;margin:0;line-height:1.5}
</style></head><body><div class="c"><h1>Couldn't start GridSight</h1><p>${safe}</p></div></body></html>`;
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 450;
  const height = Math.min(800, workArea.height - 60);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 380,
    minHeight: 520,
    x: workArea.x + workArea.width - width - 40,
    y: workArea.y + Math.round((workArea.height - height) / 2),
    title: 'GridSight Desktop Assistant',
    backgroundColor: '#07080d',
    show: true,
    autoHideMenuBar: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(SERVER_URL);
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  ipcMain.handle('agent:capture-screen', () => capturePrimaryScreen());
  ipcMain.handle('agent:move-mouse', (_e, { x, y } = {}) => moveNativeCursor(x, y));
  ipcMain.handle('agent:click-mouse', (_e, { button, double } = {}) => clickNativeMouse(button, double));
  ipcMain.handle('agent:get-cursor', () => screen.getCursorScreenPoint());
  ipcMain.handle('agent:get-windows-ui-tree', () => getWindowsUITree());
  ipcMain.handle('window:set-pinned', (_e, pinned) => {
    mainWindow?.setAlwaysOnTop(Boolean(pinned), 'floating');
    return mainWindow?.isAlwaysOnTop() ?? false;
  });

  createWindow();

  try {
    await ensureBackendServer();
    mainWindow?.loadURL(SERVER_URL);
  } catch (err) {
    console.error('Backend startup error:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopBackendServer();
  try {
    psProc?.kill();
  } catch {
    // ignore
  }
});
