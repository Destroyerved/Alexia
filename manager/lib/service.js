const fs = require('fs');
const path = require('path');
const { run, ps, psQuote } = require('./run');
const paths = require('./paths');
const envfile = require('./envfile');

/**
 * The platform runs as a Windows scheduled task under SYSTEM (install.ps1 sets it up), so it
 * starts at boot before anyone signs in and keeps running whether this window is open or not.
 * The manager only steers it.
 *
 *   start / stop   run or end the task. Stopping also writes "stopped" to C:\Alexia\desired-state,
 *                  which the watchdog respects — otherwise it would start it again in two minutes.
 *   auto-start     the task's boot trigger, and the watchdog with it.
 */

function setDesired(state) {
  try {
    fs.writeFileSync(paths.DESIRED, `${state}\r\n`);
  } catch {
    // Not installed yet; nothing to steer.
  }
}

function desired() {
  try {
    return fs.readFileSync(paths.DESIRED, 'utf8').trim() || 'running';
  } catch {
    return 'running';
  }
}

async function taskState(name = paths.TASK) {
  const result = await run('schtasks', ['/query', '/tn', name, '/fo', 'csv', '/nh'], { timeoutMs: 8000 });
  if (result.code !== 0) return 'Missing';
  const fields = result.stdout.trim().split('\n')[0]?.split('","') ?? [];
  return (fields[2] || '').replace(/"/g, '').trim() || 'Unknown';
}

/** Is the platform started with Windows (the task's boot trigger on)? */
async function autostart() {
  const result = await ps(
    `$t = Get-ScheduledTask -TaskName ${psQuote(paths.TASK)} -ErrorAction SilentlyContinue; ` +
      `if (-not $t) { 'missing' } elseif (@($t.Triggers | Where-Object { $_.Enabled }).Count -gt 0) { 'on' } else { 'off' }`,
    { timeoutMs: 15000 }
  );
  return result.stdout.trim() || 'missing';
}

async function setAutostart(on) {
  const flag = on ? '$true' : '$false';
  const result = await ps(
    `$t = Get-ScheduledTask -TaskName ${psQuote(paths.TASK)} -ErrorAction Stop; ` +
      `foreach ($tr in $t.Triggers) { $tr.Enabled = ${flag} }; ` +
      `Set-ScheduledTask -InputObject $t | Out-Null; ` +
      (on
        ? `Enable-ScheduledTask -TaskName ${psQuote(paths.WATCHDOG_TASK)} -ErrorAction SilentlyContinue | Out-Null`
        : `Disable-ScheduledTask -TaskName ${psQuote(paths.WATCHDOG_TASK)} -ErrorAction SilentlyContinue | Out-Null`),
    { timeoutMs: 20000 }
  );
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not change start-up');
}

function markCleanStop() {
  const env = envfile.read().values;
  const dataDir = env.ALEXIA_DATA_DIR || path.join(paths.ROOT, 'data');
  const file = path.join(dataDir, 'monitor.json');
  try {
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    state.cleanStop = true;
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    // First start, or not installed.
  }
}

/** Stops the AlexiaServer.exe or python process of this install, wherever it is in its restart loop. */
async function killServerProcess() {
  const appPattern = `*${paths.APP}*`;
  await ps(
    `Get-CimInstance Win32_Process | Where-Object { ` +
      `($_.Name -eq 'AlexiaServer.exe') -or ($_.Name -eq 'python.exe' -and $_.CommandLine -like ${psQuote(appPattern)}) ` +
      `} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    { timeoutMs: 20000 }
  );
}

async function start() {
  if ((await taskState()) === 'Missing') throw new Error('Alexia is not installed yet. Open Setup and install it.');
  setDesired('running');
  const result = await run('schtasks', ['/run', '/tn', paths.TASK], { timeoutMs: 10000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Could not start the task');
}

async function stop() {
  setDesired('stopped');
  markCleanStop();
  await run('schtasks', ['/end', '/tn', paths.TASK], { timeoutMs: 10000 });
  await killServerProcess();
}

async function restart() {
  markCleanStop();
  if ((await taskState()) === 'Running') {
    setDesired('running');
    await killServerProcess();
  } else {
    await start();
  }
}

/** The manager itself, started at sign-in (to the tray) with the rights it needs. */
async function managerAutostart() {
  return (await taskState(paths.MANAGER_TASK)) !== 'Missing';
}

async function setManagerAutostart(on, exePath) {
  const result = on
    ? await run('schtasks', ['/create', '/tn', paths.MANAGER_TASK, '/tr', `"${exePath}" --hidden`, '/sc', 'onlogon', '/rl', 'highest', '/f'], { timeoutMs: 10000 })
    : await run('schtasks', ['/delete', '/tn', paths.MANAGER_TASK, '/f'], { timeoutMs: 10000 });
  if (result.code !== 0 && on) throw new Error(result.stderr.trim() || 'Could not set the manager to start at sign-in');
}

module.exports = { taskState, autostart, setAutostart, start, stop, restart, desired, managerAutostart, setManagerAutostart };
