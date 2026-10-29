const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, Notification, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('./lib/paths');
const service = require('./lib/service');
const envfile = require('./lib/envfile');
const backups = require('./lib/backups');
const internet = require('./lib/internet');
const { run, ps, psQuote } = require('./lib/run');
const { follow } = require('./lib/tail');

app.setAppUserModelId('co.alexia.server.manager');

const SECRETS = new Set([
  'ALEXIA_JWT_SECRET',
  'ALEXIA_ADMIN_PASSWORD',
  'NEBIUS_API_KEY',
  'TAVILY_API_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'ALEXIA_BACKUP_PASSWORD',
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let quitting = false;
let elevated = false;
let lastState = {};
let wasRunning = null;
const consoleLines = [];
const MAX_CONSOLE = 2500;

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function logConsole(kind, text) {
  const now = Date.now();
  const entries = String(text)
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((line) => ({ at: now, kind, text: line.replace(/\x1b\[[0-9;]*m/g, '') }));
  if (!entries.length) return;
  consoleLines.push(...entries);
  if (consoleLines.length > MAX_CONSOLE) consoleLines.splice(0, consoleLines.length - MAX_CONSOLE);
  emit('console', entries);
}

async function checkElevated() {
  const res = await run('net', ['session'], { timeoutMs: 4000 });
  return res.code === 0;
}

async function askForRights() {
  if (elevated) return true;
  if (!app.isPackaged) {
    throw new Error('Start this terminal as Administrator, then run npm start again.');
  }
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Reopen as administrator', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Administrator rights needed',
    message: 'Changing the Windows service, firewall or setup needs administrator rights.',
    detail: 'Alexia Server Manager will close and open again with a Windows permission prompt.',
  });
  if (choice.response !== 0) return false;
  await ps(`Start-Process -FilePath ${psQuote(process.execPath)} -Verb RunAs`);
  quitting = true;
  app.quit();
  return false;
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        out.push({ name, address: net.address });
      }
    }
  }
  return out;
}

let prevCpu = null;
function systemCpuPercent() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  if (!prevCpu) {
    prevCpu = { idle, total };
    return 0;
  }
  const dIdle = idle - prevCpu.idle;
  const dTotal = total - prevCpu.total;
  prevCpu = { idle, total };
  return dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
}

function diskUsage() {
  try {
    const stat = fs.statfsSync(fs.existsSync(paths.ROOT) ? paths.ROOT : 'C:\\');
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bavail * stat.bsize;
    return { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes };
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1800) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

let slowInfo = { autostart: 'missing', managerAutostart: false, disk: null, lastSlowAt: 0 };

async function poll() {
  const env = envfile.read();
  const port = Number(env.values.PORT || 8080);
  const base = `http://127.0.0.1:${port}`;

  const [health, metrics, task] = await Promise.all([
    fetchJson(`${base}/v1/health`),
    fetchJson(`${base}/v1/local/metrics`),
    service.taskState(),
  ]);

  const now = Date.now();
  if (now - slowInfo.lastSlowAt > 12000) {
    const [autostart, managerAutostart] = await Promise.all([service.autostart(), service.managerAutostart()]);
    slowInfo = { autostart, managerAutostart, disk: diskUsage(), lastSlowAt: now };
  }

  const installedVersion = paths.installedVersion();
  const bundledVersion = paths.bundledVersion();
  const installed = paths.isInstalled();
  const running = Boolean(health && (health.ok || health.status === 'healthy'));
  const desired = service.desired();

  if (wasRunning === true && !running && desired !== 'stopped' && Notification.isSupported()) {
    new Notification({
      title: 'Alexia has stopped answering',
      body: 'The watchdog will restart it automatically, or open Alexia Server Manager to inspect the logs.',
    }).show();
  }
  wasRunning = running;

  const backupList = installed ? backups.list() : { backups: [] };
  const safeValues = {};
  const secretsSet = {};
  for (const [key, value] of Object.entries(env.values)) {
    if (SECRETS.has(key)) secretsSet[key] = Boolean(value);
    else safeValues[key] = value;
  }

  lastState = {
    at: now,
    elevated,
    needsRights: !elevated,
    installed,
    legacy: false,
    installedVersion,
    bundledVersion,
    task,
    desired,
    autostart: slowInfo.autostart,
    managerAutostart: slowInfo.managerAutostart,
    running,
    port,
    health,
    metrics,
    settings: safeValues,
    secretsSet,
    internetUrl: (health && health.internetUrl) || env.values.ALEXIA_INTERNET_URL || '',
    lan: lanAddresses(),
    machine: {
      hostname: os.hostname(),
      cpuPercent: systemCpuPercent(),
      cores: os.cpus().length,
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      uptimeSec: Math.floor(os.uptime()),
      disk: slowInfo.disk,
      lan: lanAddresses().map((n) => n.address),
    },
    lastBackup: backupList.backups[0] || null,
    backupCount: backupList.backups.length,
    root: paths.ROOT,
    installRoot: paths.INSTALL_ROOT,
  };

  emit('state', lastState);
  updateTray();
}

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 1020,
    minHeight: 660,
    show: false,
    title: 'Alexia Server Manager',
    backgroundColor: '#f3f8fc',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (show) win.show();
    if (process.argv.includes('--capture')) {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, 'capture.png'), image.toPNG());
        quitting = true;
        app.quit();
      }, 2200);
    }
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Alexia Server Manager');
  tray.on('click', () => {
    if (!win) createWindow(true);
    else {
      win.show();
      win.focus();
    }
  });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const status = !lastState.installed
    ? 'Alexia: not installed'
    : lastState.running
      ? `Alexia ${lastState.installedVersion || ''} — running`
      : lastState.desired === 'stopped'
        ? 'Alexia — stopped'
        : 'Alexia — not answering';
  tray.setToolTip(status);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      {
        label: 'Open Alexia Server Manager',
        click: () => {
          win.show();
          win.focus();
        },
      },
      {
        label: 'Open Guardian Console',
        enabled: Boolean(lastState.running),
        click: () => {
          win.show();
          win.focus();
          emit('show-tab', 'admin');
        },
      },
      { type: 'separator' },
      { label: 'Start Alexia', enabled: Boolean(lastState.installed && !lastState.running), click: () => runAction('Start', () => service.start()) },
      { label: 'Restart Alexia', enabled: Boolean(lastState.installed && lastState.running), click: () => runAction('Restart', () => service.restart()) },
      { label: 'Stop Alexia', enabled: Boolean(lastState.installed && lastState.running), click: () => runAction('Stop', () => service.stop()) },
      { label: 'Back up now', enabled: Boolean(lastState.installed), click: () => runAction('Backup', () => backups.backupNow((l) => logConsole('manager', l))) },
      { type: 'separator' },
      {
        label: 'Quit Manager (Alexia keeps running)',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

async function runAction(label, fn, { needsAdmin = true } = {}) {
  try {
    if (needsAdmin && !(await askForRights())) return { ok: false, error: 'Cancelled' };
    logConsole('manager', `▸ ${label}`);
    const result = await fn();
    await poll();
    return { ok: true, result };
  } catch (err) {
    const message = err.message || String(err);
    logConsole('error', `✗ ${label}: ${message}`);
    return { ok: false, error: message };
  }
}

async function runInstall(options = {}) {
  const bundle = paths.bundleDir();
  const script = path.join(bundle, 'windows', 'install.ps1');
  const serverDir = path.join(bundle, 'server');
  if (!fs.existsSync(script) || !fs.existsSync(serverDir)) {
    throw new Error('This build does not contain the bundled server files. Run "npm run bundle" first.');
  }
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Root',
    paths.INSTALL_ROOT,
    '-SourceDir',
    serverDir,
  ];
  if (options.tailscale) args.push('-Tailscale');
  if (options.funnel) args.push('-Funnel');
  if (options.remoteDesktop) args.push('-RemoteDesktop');
  if (options.skipTuning) args.push('-SkipSystemTuning');
  if (options.cloudflareToken) args.push('-CloudflareToken', options.cloudflareToken, '-InternetUrl', options.internetUrl || '');

  const found = { adminPassword: null, ntfyTopic: null, internetUrl: null };
  const result = await run('powershell.exe', args, {
    onLine: (line) => {
      logConsole('install', line);
      const pw = /Password\s+(\S+)/.exec(line);
      if (pw) found.adminPassword = pw[1];
      const ntfy = /^\s+(alexia-[a-f0-9]+)\s*$/.exec(line);
      if (ntfy) found.ntfyTopic = ntfy[1];
      const url = /Internet address\s*:\s*(\S+)/.exec(line);
      if (url) found.internetUrl = url[1];
    },
    timeoutMs: 20 * 60 * 1000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Setup did not finish — check the Console tab for the last step.');
  }
  return found;
}

async function runCommand(raw) {
  const line = String(raw || '').trim();
  if (!line) return { ok: true };
  logConsole('command', `alexia> ${line}`);
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd.toLowerCase()) {
    case 'help':
    case '?':
      logConsole(
        'info',
        [
          'Commands you can run here:',
          '  status            Full health & audit check (runs check.ps1)',
          '  start             Start the Alexia platform',
          '  stop              Stop the Alexia platform',
          '  restart           Restart the Alexia platform',
          '  backup            Take an online SQLite database backup now',
          '  health            Show the live /v1/health response',
          '  tailscale         Show Tailscale and Funnel status',
          '  open data|logs|backups|app   Open that folder in Explorer',
          '  clear             Clear this console window',
        ].join('\n')
      );
      return { ok: true };
    case 'clear':
    case 'cls':
      consoleLines.length = 0;
      emit('console-clear');
      return { ok: true };
    case 'start':
      return runAction('Start Alexia', () => service.start());
    case 'stop':
      return runAction('Stop Alexia', () => service.stop());
    case 'restart':
      return runAction('Restart Alexia', () => service.restart());
    case 'backup':
      return runAction('Back up now', () => backups.backupNow((l) => logConsole('manager', l)), { needsAdmin: false });
    case 'health': {
      // Ask the server now rather than reporting the last poll, which can lag on a busy machine
      const port = Number(envfile.read().values.PORT || 8080);
      const health = await fetchJson(`http://127.0.0.1:${port}/v1/health`);
      logConsole('info', JSON.stringify(health || { ok: false, error: `not answering on port ${port}` }, null, 2));
      return { ok: Boolean(health) };
    }
    case 'status':
    case 'check': {
      const checkScript = [path.join(paths.ROOT, 'check.ps1'), path.join(paths.bundleDir(), 'windows', 'check.ps1')].find((f) => fs.existsSync(f));
      if (!checkScript) {
        logConsole('error', 'check.ps1 not found');
        return { ok: false };
      }
      await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checkScript, '-Root', paths.ROOT], {
        onLine: (l) => logConsole('info', l),
        timeoutMs: 30000,
      });
      return { ok: true };
    }
    case 'tailscale': {
      const s = await internet.tailscaleStatus();
      logConsole('info', JSON.stringify(s, null, 2));
      return { ok: true };
    }
    case 'open': {
      const map = { data: paths.DATA, logs: paths.LOGS, backups: paths.BACKUPS, app: paths.APP, root: paths.ROOT };
      const target = map[arg.toLowerCase()] || paths.ROOT;
      shell.openPath(target);
      return { ok: true };
    }
    default:
      logConsole('error', `Unknown command "${cmd}". Type "help" for the list.`);
      return { ok: false };
  }
}

ipcMain.handle('state', () => lastState);
ipcMain.handle('console-history', () => consoleLines);
ipcMain.handle('command', (_e, line) => runCommand(line));
ipcMain.handle('start', () => runAction('Start Alexia', () => service.start()));
ipcMain.handle('stop', () => runAction('Stop Alexia', () => service.stop()));
ipcMain.handle('restart', () => runAction('Restart Alexia', () => service.restart()));
ipcMain.handle('autostart', (_e, on) => runAction(on ? 'Start with Windows: on' : 'Start with Windows: off', () => service.setAutostart(Boolean(on))));
ipcMain.handle('manager-autostart', (_e, on) =>
  runAction(on ? 'Open manager at sign-in: on' : 'Open manager at sign-in: off', () => service.setManagerAutostart(Boolean(on), process.execPath))
);
ipcMain.handle('install', (_e, options) => runAction('Setup', () => runInstall(options)));

ipcMain.handle('backups', () => (paths.isInstalled() ? { ok: true, result: backups.list() } : { ok: false, error: 'Not installed yet' }));
ipcMain.handle('backup-now', () => runAction('Back up now', () => backups.backupNow((l) => logConsole('manager', l)), { needsAdmin: false }));
ipcMain.handle('backup-restore', async (_e, name) => {
  const choice = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Restore this backup', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Restore database backup',
    message: `Replace the current database with ${name}?`,
    detail: 'Alexia will stop briefly. The current database will be preserved alongside as alexia.db.before-restore-… before the backup is put in place.',
  });
  if (choice.response !== 0) return { ok: false, error: 'Cancelled' };
  return runAction(`Restore ${name}`, () => backups.restore(name, (l) => logConsole('manager', l)));
});
ipcMain.handle('backup-delete', async (_e, name) => {
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Delete backup', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Delete backup',
    message: `Delete ${name}?`,
  });
  if (choice.response !== 0) return { ok: false, error: 'Cancelled' };
  return runAction(`Delete ${name}`, () => backups.remove(name), { needsAdmin: false });
});

ipcMain.handle('settings-save', async (_e, updates) =>
  runAction(
    'Save settings',
    async () => {
      const clean = {};
      for (const [key, value] of Object.entries(updates || {})) {
        if (!/^[A-Z0-9_]+$/.test(key)) continue;
        clean[key] = String(value ?? '').replace(/[\r\n]/g, '');
      }
      envfile.write(clean);
    },
    { needsAdmin: true }
  )
);

ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('internet-tailscale', () => internet.tailscaleStatus());
ipcMain.handle('internet-cloudflare', () => internet.cloudflareStatus());
ipcMain.handle('internet-check', (_e, url) => internet.checkPublic(url));
ipcMain.handle('tailscale-install', () => runAction('Install Tailscale', () => internet.installTailscale((l) => logConsole('install', l))));
ipcMain.handle('tailscale-connect', () =>
  runAction('Connect Tailscale', () =>
    internet.connectTailscale((l) => {
      logConsole('install', l);
      const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(l);
      if (url) shell.openExternal(url[0]);
    })
  )
);
ipcMain.handle('funnel-on', () =>
  runAction('Turn on Tailscale Funnel', async () => {
    const url = await internet.enableFunnel((l) => {
      logConsole('install', l);
      const enable = /https:\/\/login\.tailscale\.com\/\S+/.exec(l);
      if (enable) {
        emit('open-link', enable[0]);
      }
    });
    await service.restart();
    return url;
  })
);
ipcMain.handle('funnel-off', () =>
  runAction('Turn off Tailscale Funnel', async () => {
    await internet.disableFunnel((l) => logConsole('install', l));
    await service.restart();
  })
);
ipcMain.handle('cloudflare-setup', (_e, token, url) =>
  runAction('Set up Cloudflare Tunnel', async () => {
    await internet.setupCloudflare(token, url, (l) => logConsole('install', l));
    await service.restart();
  })
);
ipcMain.handle('quick-tunnel-on', () =>
  runAction('Use a Cloudflare quick tunnel', async () => {
    internet.useQuickTunnel();
    await service.restart();
  })
);

ipcMain.handle('open', (_e, target) => {
  const port = Number(envfile.read().values.PORT || 8080);
  const map = {
    root: paths.ROOT,
    app: paths.APP,
    data: paths.DATA,
    backups: backups.locations().main,
    logs: paths.LOGS,
    env: paths.ENV_FILE,
    admin: `http://127.0.0.1:${port}/`,
    console: `http://127.0.0.1:${port}/`,
  };
  const dest = map[target] || target;
  if (/^https?:\/\//.test(dest)) return shell.openExternal(dest);
  return shell.openPath(dest);
});
ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) return shell.openExternal(url);
});
ipcMain.handle('copy', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

app.on('second-instance', () => {
  if (win) {
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  elevated = await checkElevated();
  const hidden = process.argv.includes('--hidden');
  createWindow(!hidden);
  createTray();

  follow(paths.LOG_FILE, (lines) => logConsole('log', lines.join('\n')));
  follow(paths.WATCHDOG_LOG, (lines) => logConsole('watchdog', lines.map((l) => `[watchdog] ${l}`).join('\n')), { initialBytes: 16 * 1024 });

  logConsole('manager', `Alexia Server Manager ${app.getVersion()} (${elevated ? 'Administrator' : 'standard user — reopen as Administrator to change services'})`);
  await poll();
  setInterval(poll, 2000);
});

app.on('before-quit', () => {
  quitting = true;
});
