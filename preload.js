'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usageWidget', Object.freeze({
  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  refreshProviders: (providerId) => ipcRenderer.invoke('providers:refresh', providerId),
  connectClaude: () => ipcRenderer.invoke('claude:connect'),
  disconnectClaude: () => ipcRenderer.invoke('claude:disconnect'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseCodexExecutable: () => ipcRenderer.invoke('codex:choose-executable'),
  copyDiagnostics: () => ipcRenderer.invoke('diagnostics:copy'),
  openLink: (key) => ipcRenderer.invoke('link:open', key),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  setCompactMode: (compact) => ipcRenderer.invoke('window:set-mode', compact === true),
  onSnapshotsUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('snapshots-updated', listener);
    return () => ipcRenderer.removeListener('snapshots-updated', listener);
  },
  onMigrationComplete: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('migration-complete', listener);
    return () => ipcRenderer.removeListener('migration-complete', listener);
  },
  platform: process.platform
}));
