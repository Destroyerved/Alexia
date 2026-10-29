const { spawn } = require('child_process');

/**
 * Runs a program without a console window, handing each line of output to `onLine` as it arrives
 * — which is what lets the install, backups and Tailscale show up live in the manager's console.
 */
function run(command, args = [], { cwd, env, onLine, timeoutMs = 0, input } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err.message || err) });
      return;
    }
    const lines = (stream, sink) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        sink(chunk);
        pending += chunk;
        const parts = pending.split(/\r?\n/);
        pending = parts.pop();
        for (const line of parts) if (onLine) onLine(line, stream === child.stderr);
      });
      stream.on('end', () => {
        if (pending && onLine) onLine(pending, stream === child.stderr);
      });
    };
    lines(child.stdout, (c) => (stdout += c));
    lines(child.stderr, (c) => (stderr += c));
    let timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err.message || err) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/** A PowerShell script, run the same way. */
function ps(script, options = {}) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], options);
}

/** Quotes a value for use inside a single-quoted PowerShell string. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

module.exports = { run, ps, psQuote };
