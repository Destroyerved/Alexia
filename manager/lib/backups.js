const fs = require('fs');
const path = require('path');
const { run } = require('./run');
const paths = require('./paths');
const envfile = require('./envfile');
const service = require('./service');

/**
 * Backups, as the platform takes them: alexia-YYYYMMDD-HHMMSS.db in the backup folder, and the
 * same files in the second-copy folder when one is set.
 */
const NAME = /^alexia-\d{8}-\d{6}\.db$/;

function locations() {
  const env = envfile.read().values;
  return {
    main: env.ALEXIA_BACKUP_DIR || path.join(paths.ROOT, 'backups'),
    copy: env.ALEXIA_BACKUP_COPY_DIR || null,
    data: env.ALEXIA_DATA_DIR || path.join(paths.ROOT, 'data'),
    db: env.ALEXIA_DB || null,
    keep: Number(env.ALEXIA_BACKUP_KEEP || 14),
    hour: Number(env.ALEXIA_BACKUP_HOUR || 3),
  };
}

function listDir(dir, where) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => NAME.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, bytes: stat.size, createdAt: stat.mtimeMs, where };
    });
}

function list() {
  const where = locations();
  const main = listDir(where.main, 'main');
  const copies = new Set(listDir(where.copy, 'copy').map((b) => b.name));
  return {
    ...where,
    copyReachable: where.copy ? fs.existsSync(where.copy) : null,
    backups: main.map((b) => ({ ...b, copied: copies.has(b.name) })).sort((a, b) => b.createdAt - a.createdAt),
  };
}

/** Runs the platform's online SQLite backup tool (`AlexiaServer.exe --backup` or `python -m alexia.tools.backup`). */
async function backupNow(onLine) {
  if (!paths.isInstalled()) throw new Error('Alexia is not installed yet.');
  const where = locations();
  const env = {
    ALEXIA_DATA_DIR: where.data,
    ALEXIA_BACKUP_DIR: where.main,
    ALEXIA_BACKUP_COPY_DIR: where.copy || '',
    ALEXIA_BACKUP_KEEP: String(where.keep),
  };
  let result;
  if (fs.existsSync(paths.SERVER_EXE)) {
    result = await run(paths.SERVER_EXE, ['--backup'], { cwd: paths.APP, env, onLine, timeoutMs: 120000 });
  } else {
    result = await run('python', ['-m', 'alexia.tools.backup'], { cwd: paths.APP, env, onLine, timeoutMs: 120000 });
  }
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'The backup failed');
}

function dbFile() {
  const where = locations();
  if (where.db) return where.db;
  return path.join(where.data, 'alexia.db');
}

/**
 * Restores a backup: stops Alexia, preserves the current database as
 * `alexia.db.before-restore-<time>`, copies the backup into place, and restarts Alexia.
 */
async function restore(name, onLine) {
  if (!NAME.test(name)) throw new Error('That is not an Alexia backup');
  const where = locations();
  const from = [where.main, where.copy].filter(Boolean).map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
  if (!from) throw new Error('Backup not found');
  const db = dbFile();
  const say = (line) => onLine && onLine(line);

  say(`Stopping Alexia to restore ${name}`);
  await service.stop();
  await new Promise((r) => setTimeout(r, 1500));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(db)) {
    const keep = `${db}.before-restore-${stamp}`;
    fs.copyFileSync(db, keep);
    if (fs.existsSync(`${db}-wal`)) fs.copyFileSync(`${db}-wal`, `${keep}-wal`);
    say(`Current database preserved as ${path.basename(keep)}`);
  }
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(db + suffix)) fs.rmSync(db + suffix, { force: true });
  }
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.copyFileSync(from, db);
  say('Backup copied into place. Starting Alexia');
  await service.start();
}

function remove(name) {
  if (!NAME.test(name)) throw new Error('That is not an Alexia backup');
  const where = locations();
  fs.rmSync(path.join(where.main, name), { force: true });
}

module.exports = { list, backupNow, restore, remove, locations };
