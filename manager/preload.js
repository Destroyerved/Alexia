const { contextBridge, ipcRenderer } = require('electron');

const api = {
  state: () => ipcRenderer.invoke('state'),
  consoleHistory: () => ipcRenderer.invoke('console-history'),
  command: (line) => ipcRenderer.invoke('command', line),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  restart: () => ipcRenderer.invoke('restart'),
  setAutostart: (on) => ipcRenderer.invoke('autostart', on),
  setManagerAutostart: (on) => ipcRenderer.invoke('manager-autostart', on),
  install: (options) => ipcRenderer.invoke('install', options),

  backups: () => ipcRenderer.invoke('backups'),
  backupNow: () => ipcRenderer.invoke('backup-now'),
  restore: (name) => ipcRenderer.invoke('backup-restore', name),
  deleteBackup: (name) => ipcRenderer.invoke('backup-delete', name),

  saveSettings: (updates) => ipcRenderer.invoke('settings-save', updates),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  tailscaleStatus: () => ipcRenderer.invoke('internet-tailscale'),
  cloudflareStatus: () => ipcRenderer.invoke('internet-cloudflare'),
  checkPublic: (url) => ipcRenderer.invoke('internet-check', url),
  tailscaleInstall: () => ipcRenderer.invoke('tailscale-install'),
  tailscaleConnect: () => ipcRenderer.invoke('tailscale-connect'),
  funnelOn: () => ipcRenderer.invoke('funnel-on'),
  funnelOff: () => ipcRenderer.invoke('funnel-off'),
  cloudflareSetup: (token, url) => ipcRenderer.invoke('cloudflare-setup', token, url),
  quickTunnelOn: () => ipcRenderer.invoke('quick-tunnel-on'),

  open: (target) => ipcRenderer.invoke('open', target),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copy: (text) => ipcRenderer.invoke('copy', text),

  on: (channel, handler) => {
    const allowed = ['state', 'console', 'console-clear', 'show-tab', 'open-link'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, data) => handler(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('alexia', api);
