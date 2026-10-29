const fs = require('fs');
const paths = require('./paths');

/**
 * Reads and updates `C:\Alexia\app\.env` while preserving comments, blank lines, and ordering.
 */
function readLines() {
  try {
    return fs.readFileSync(paths.ENV_FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  } catch {
    return null;
  }
}

function read() {
  const lines = readLines();
  const values = {};
  if (!lines) return { exists: false, values };
  for (const line of lines) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) {
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
  }
  return { exists: true, values };
}

function write(updates) {
  const lines = readLines();
  if (!lines) throw new Error('The platform is not installed yet: there is no settings file.');
  const pending = { ...updates };
  const out = lines.map((line) => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    const key = match && match[1];
    if (key && Object.prototype.hasOwnProperty.call(pending, key)) {
      const value = pending[key];
      delete pending[key];
      return `${key}=${value}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [key, value] of Object.entries(pending)) out.push(`${key}=${value}`);
  fs.writeFileSync(paths.ENV_FILE, out.join('\r\n') + '\r\n', 'utf8');
}

module.exports = { read, write };
