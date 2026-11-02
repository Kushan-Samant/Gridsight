/**
 * GridSight — Electron Preload Bridge (electron/preload.cjs)
 * Exposes safe IPC methods to the renderer process at window.electronAPI
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  captureScreen: () => ipcRenderer.invoke('agent:capture-screen'),
  moveMouse: (x, y) => ipcRenderer.invoke('agent:move-mouse', { x, y }),
  clickMouse: (button, double) => ipcRenderer.invoke('agent:click-mouse', { button, double }),
  getCursorPoint: () => ipcRenderer.invoke('agent:get-cursor'),
  setPinned: (pinned) => ipcRenderer.invoke('window:set-pinned', pinned),
});
