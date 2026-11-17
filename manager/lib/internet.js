const fs = require('fs');
const { run } = require('./run');
const envfile = require('./envfile');

/**
 * Getting the Alexia DevSecOps Guardian onto the internet without touching the router:
 *   - Tailscale Funnel: free permanent https://<pc>.<tailnet>.ts.net address
 *   - Cloudflare Tunnel: custom domain via cloudflared Windows service
 *   - Quick Tunnel: zero-account trycloudflare.com tunnel
 */
const TAILSCALE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const INTERNET_PORT = 8080;

function hasTailscale() {
  return fs.existsSync(TAILSCALE);
}

async function tailscaleStatus() {
  if (!hasTailscale()) return { installed: false };
  const status = await run(TAILSCALE, ['status', '--json'], { timeoutMs: 10000 });
  let parsed = null;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    parsed = null;
  }
  const dnsName = parsed?.Self?.DNSName ? String(parsed.Self.DNSName).replace(/\.$/, '') : null;
  const funnel = await run(TAILSCALE, ['funnel', 'status'], { timeoutMs: 10000 });
  const funnelText = `${funnel.stdout}\n${funnel.stderr}`;
  return {
    installed: true,
    state: parsed?.BackendState || 'Unknown',
    dnsName,
    ips: parsed?.Self?.TailscaleIPs || [],
    funnelOn: /Funnel on/i.test(funnelText),
    funnelText: funnelText.trim(),
    url: dnsName ? `https://${dnsName}` : null,
  };
}

async function installTailscale(onLine) {
  const result = await run('winget', ['install', '--id', 'Tailscale.Tailscale', '--silent', '--accept-package-agreements', '--accept-source-agreements'], {
    onLine,
    timeoutMs: 15 * 60 * 1000,
  });
  if (!hasTailscale()) throw new Error(result.stderr.trim() || 'Tailscale did not install. Get it from tailscale.com/download.');
}

async function connectTailscale(onLine) {
  const result = await run(TAILSCALE, ['up', '--unattended'], { onLine, timeoutMs: 10 * 60 * 1000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Tailscale did not connect');
}

async function enableFunnel(onLine) {
  const port = Number(envfile.read().values.PORT || INTERNET_PORT);
  const result = await run(TAILSCALE, ['funnel', '--bg', String(port)], { onLine, timeoutMs: 10 * 60 * 1000 });
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    throw new Error(/https:\/\/login\.tailscale\.com\S*/.exec(text)?.[0]
      ? `Allow Funnel for your Tailscale network first: ${/https:\/\/login\.tailscale\.com\S*/.exec(text)[0]} — then try again.`
      : text.trim() || 'Funnel could not be switched on');
  }
  const status = await tailscaleStatus();
  if (!status.url) throw new Error('Funnel is on, but this PC has no Tailscale name yet');
  envfile.write({ ALEXIA_INTERNET_PORT: String(port), ALEXIA_INTERNET_URL: status.url, ALEXIA_TUNNEL: '' });
  return status.url;
}

async function disableFunnel(onLine) {
  let result = await run(TAILSCALE, ['funnel', '--https=443', 'off'], { onLine, timeoutMs: 60000 });
  if (result.code !== 0) result = await run(TAILSCALE, ['funnel', 'reset'], { onLine, timeoutMs: 60000 });
  envfile.write({ ALEXIA_INTERNET_URL: '' });
}

async function cloudflareStatus() {
  const result = await run('sc', ['query', 'cloudflared'], { timeoutMs: 8000 });
  if (/FAILED 1060/.test(result.stdout) || result.code === 1060) return { installed: false };
  return { installed: true, running: /RUNNING/.test(result.stdout) };
}

async function setupCloudflare(token, url, onLine) {
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url.trim().replace(/\/+$/, ''))) throw new Error('The public address must look like https://alexia.example.com');
  if (token.trim().length < 40) throw new Error('That does not look like a Cloudflare tunnel token');
  let cloudflared = await findCloudflared();
  if (!cloudflared) {
    onLine && onLine('Installing cloudflared…');
    await run('winget', ['install', '--id', 'Cloudflare.cloudflared', '--silent', '--accept-package-agreements', '--accept-source-agreements'], {
      onLine,
      timeoutMs: 15 * 60 * 1000,
    });
    cloudflared = await findCloudflared();
    if (!cloudflared) throw new Error('cloudflared did not install. Get it from Cloudflare, then try again.');
  }
  const status = await cloudflareStatus();
  if (!status.installed) {
    const result = await run(cloudflared, ['service', 'install', token.trim()], { onLine, timeoutMs: 120000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'cloudflared could not install its service');
  }
  await run('sc', ['config', 'cloudflared', 'start=', 'auto'], { timeoutMs: 8000 });
  await run('sc', ['start', 'cloudflared'], { timeoutMs: 15000 });
  const port = Number(envfile.read().values.PORT || INTERNET_PORT);
  envfile.write({ ALEXIA_INTERNET_PORT: String(port), ALEXIA_INTERNET_URL: url.trim().replace(/\/+$/, ''), ALEXIA_TUNNEL: '' });
}

async function findCloudflared() {
  for (const candidate of ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const where = await run('where', ['cloudflared'], { timeoutMs: 5000 });
  return where.code === 0 ? where.stdout.split(/\r?\n/)[0].trim() : null;
}

function useQuickTunnel() {
  const port = Number(envfile.read().values.PORT || INTERNET_PORT);
  envfile.write({ ALEXIA_INTERNET_PORT: String(port), ALEXIA_TUNNEL: 'quick', ALEXIA_INTERNET_URL: '' });
}

async function publicAddress(host) {
  for (const [url, headers] of [
    [`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`, {}],
    [`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, { accept: 'application/dns-json' }],
  ]) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      if (!response.ok) continue;
      const body = await response.json();
      const a = (body.Answer || []).find((answer) => answer.type === 1);
      return { reached: true, ip: a ? a.data : null };
    } catch {
      // Try the next resolver.
    }
  }
  return { reached: false, ip: null };
}

async function checkPublic(url) {
  if (!url) return { ok: false, reason: 'No internet address set' };
  let target;
  try {
    target = new URL('/v1/health', url);
  } catch {
    return { ok: false, reason: 'Not a valid address' };
  }
  const found = await publicAddress(target.hostname);
  if (found.reached && !found.ip) return { ok: false, reason: `public DNS has no address for ${target.hostname}` };
  return new Promise((resolve) => {
    const https = require('https');
    const options = { timeout: 10000 };
    if (found.ip) {
      options.lookup = (_host, opts, callback) =>
        opts && opts.all ? callback(null, [{ address: found.ip, family: 4 }]) : callback(null, found.ip, 4);
    }
    const request = https.request(target, options, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 64000) body += chunk;
      });
      response.on('end', () => {
        let service;
        try {
          service = JSON.parse(body).service;
        } catch {
          service = undefined;
        }
        resolve({ ok: response.statusCode === 200 && ['alexia-guardian', 'alexia-platform'].includes(service), status: response.statusCode });
      });
    });
    request.on('timeout', () => request.destroy(new Error('no answer in 10 s')));
    request.on('error', (err) => resolve({ ok: false, reason: err.message }));
    request.end();
  });
}

module.exports = {
  useQuickTunnel,
  INTERNET_PORT,
  hasTailscale,
  tailscaleStatus,
  installTailscale,
  connectTailscale,
  enableFunnel,
  disableFunnel,
  cloudflareStatus,
  setupCloudflare,
  checkPublic,
};
