const fs = require('fs');
const path = require('path');

/**
 * Everything the Alexia platform puts on disk lives under C:\Alexia.
 * The manager itself is installed wherever the user chose (`C:\Program Files\Alexia Server Manager`
 * by default), and carries a bundled copy of the server in its `resources/bundle/` folder so it
 * can install or upgrade `C:\Alexia\app` without downloading anything.
 */
const ROOT = process.env.ALEXIA_ROOT || 'C:\\Alexia';

function bundleDir() {
  const packaged = path.join(process.resourcesPath || '', 'bundle');
  if (fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, '..', 'bundle');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  ROOT,
  INSTALL_ROOT: ROOT,
  get APP() {
    return path.join(module.exports.ROOT, 'app');
  },
  get DATA() {
    return path.join(module.exports.ROOT, 'data');
  },
  get BACKUPS() {
    return path.join(module.exports.ROOT, 'backups');
  },
  get LOGS() {
    return path.join(module.exports.ROOT, 'logs');
  },
  get ENV_FILE() {
    return path.join(module.exports.APP, '.env');
  },
  get LOG_FILE() {
    return path.join(module.exports.LOGS, 'alexia.log');
  },
  get WATCHDOG_LOG() {
    return path.join(module.exports.LOGS, 'watchdog.log');
  },
  get DESIRED() {
    return path.join(module.exports.ROOT, 'desired-state');
  },
  get SERVER_EXE() {
    const appExe = path.join(module.exports.APP, 'AlexiaServer.exe');
    if (fs.existsSync(appExe)) return appExe;
    return path.join(module.exports.ROOT, 'runtime', 'AlexiaServer.exe');
  },
  TASK: 'Alexia',
  WATCHDOG_TASK: 'Alexia watchdog',
  MANAGER_TASK: 'Alexia Manager',
  bundleDir,
  readJson,
  installedVersion() {
    const pkg = readJson(path.join(module.exports.APP, 'package.json'));
    if (pkg?.version) return pkg.version;
    if (fs.existsSync(path.join(module.exports.APP, 'AlexiaServer.exe')) || fs.existsSync(path.join(module.exports.APP, 'launcher.py'))) {
      return '1.0.0';
    }
    return null;
  },
  bundledVersion() {
    return readJson(path.join(bundleDir(), 'server', 'package.json'))?.version ?? '1.0.0';
  },
  isInstalled() {
    return (
      fs.existsSync(path.join(module.exports.APP, 'AlexiaServer.exe')) ||
      fs.existsSync(path.join(module.exports.APP, 'launcher.py'))
    );
  },
};
