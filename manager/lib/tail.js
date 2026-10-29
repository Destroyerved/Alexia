const fs = require('fs');

/**
 * Follows a log file the way `tail -f` does: the last part of it at the start, then every line
 * added after. Copes with the file being rotated (it shrinks) or not existing yet.
 */
function follow(file, onLines, { initialBytes = 128 * 1024, intervalMs = 600 } = {}) {
  let offset = 0;
  let carry = '';
  let stopped = false;

  function readFrom(start, end) {
    const length = end - start;
    if (length <= 0) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const text = carry + buffer.toString('utf8');
      const lines = text.split(/\r?\n/);
      carry = lines.pop();
      if (lines.length) onLines(lines);
    } finally {
      fs.closeSync(fd);
    }
  }

  function tick() {
    if (stopped) return;
    try {
      const { size } = fs.statSync(file);
      if (size < offset) {
        offset = 0;
        carry = '';
        onLines(['— log rotated —']);
      }
      if (size > offset) {
        readFrom(offset, size);
        offset = size;
      }
    } catch {
      // Not there yet.
    }
  }

  try {
    const { size } = fs.statSync(file);
    offset = Math.max(0, size - initialBytes);
    if (offset > 0) {
      const fd = fs.openSync(file, 'r');
      const probe = Buffer.alloc(Math.min(4096, size - offset));
      fs.readSync(fd, probe, 0, probe.length, offset);
      fs.closeSync(fd);
      const newline = probe.indexOf(10);
      if (newline >= 0) offset += newline + 1;
    }
    readFrom(offset, size);
    offset = size;
  } catch {
    // Not there yet.
  }

  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { follow };
