/**
 * Gathers everything the Alexia Server Manager needs to install and run the Alexia DevSecOps
 * Guardian on a PC that has nothing else on it, and puts it under `manager/bundle/`:
 *
 *   bundle/server/    AlexiaServer.exe, launcher.py, MainFrame.py, alexia/, dashboard/static/,
 *                     config/, target-app/, package.json, .env.example
 *   bundle/windows/   install.ps1, watchdog.ps1, check.ps1, restart.ps1
 *
 * `electron-builder` copies `bundle/` into the installer's `resources/bundle/`, so Setup works
 * without winget, Python, Node.js, or an internet connection.
 */
const fs = require('fs');
const path = require('path');

const managerDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(managerDir, '..');
const deployWin = path.join(repoRoot, 'deploy', 'windows');
const bundleDir = path.join(managerDir, 'bundle');

function say(text) {
  console.log(`\x1b[36m==>\x1b[0m ${text}`);
}

function copyTree(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name === '.pytest_cache' || entry.name.endsWith('.pyc')) {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (filter && !filter(from, entry)) continue;
    if (entry.isDirectory()) copyTree(from, to, filter);
    else fs.copyFileSync(from, to);
  }
}

function main() {
  say('Preparing clean manager/bundle directory');
  fs.rmSync(bundleDir, { recursive: true, force: true });
  const serverOut = path.join(bundleDir, 'server');
  const winOut = path.join(bundleDir, 'windows');
  fs.mkdirSync(serverOut, { recursive: true });
  fs.mkdirSync(winOut, { recursive: true });

  // 1. Copy standalone AlexiaServer.exe if built
  const exePath = path.join(repoRoot, 'AlexiaServer.exe');
  if (fs.existsSync(exePath)) {
    say('Bundling standalone AlexiaServer.exe runtime');
    fs.copyFileSync(exePath, path.join(serverOut, 'AlexiaServer.exe'));
  } else {
    console.warn('Warning: AlexiaServer.exe not found at repo root; bundling Python source files.');
  }

  // 2. Copy server source & static assets
  say('Copying Alexia platform files into bundle/server');
  for (const file of ['launcher.py', 'MainFrame.py', 'package.json', '.env.example', 'requirements.txt']) {
    const srcFile = path.join(repoRoot, file);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(serverOut, file));
    }
  }
  for (const folder of ['alexia', 'dashboard', 'config', 'target-app']) {
    const srcFolder = path.join(repoRoot, folder);
    if (fs.existsSync(srcFolder)) {
      copyTree(srcFolder, path.join(serverOut, folder));
    }
  }

  // 3. Copy Windows deployment scripts
  say('Copying Windows deployment scripts into bundle/windows');
  for (const script of ['install.ps1', 'watchdog.ps1', 'check.ps1', 'restart.ps1']) {
    const srcScript = path.join(deployWin, script);
    if (fs.existsSync(srcScript)) {
      fs.copyFileSync(srcScript, path.join(winOut, script));
    }
  }

  say('Bundle ready in manager/bundle/');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
