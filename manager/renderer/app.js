(function () {
  'use strict';
  const api = window.alexia;
  const $ = (id) => document.getElementById(id);
  let state = {};
  let currentTab = 'dashboard';

  // ---------------------------------------------------------------- helpers

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function bytes(n) {
    if (n == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }
  function duration(sec) {
    if (sec == null) return '—';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${Math.floor(sec)}s`;
  }
  function when(ms) {
    if (!ms) return '—';
    const ago = (Date.now() - ms) / 1000;
    const date = new Date(ms);
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (ago < 60) return 'just now';
    if (ago < 3600) return `${Math.round(ago / 60)} min ago`;
    if (date.toDateString() === new Date().toDateString()) return `today ${time}`;
    return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
  }
  function toast(text, bad) {
    const el = $('toast');
    el.textContent = text;
    el.className = `toast${bad ? ' bad' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), 3800);
  }
  async function busy(button, fn, success) {
    if (button) button.classList.add('busy');
    try {
      const result = await fn();
      if (result && result.ok === false) {
        if (result.error !== 'Cancelled') toast(result.error, true);
        return result;
      }
      if (success) toast(success);
      return result;
    } catch (err) {
      toast(err.message || String(err), true);
    } finally {
      if (button) button.classList.remove('busy');
    }
  }

  // ---------------------------------------------------------------- tabs

  function show(tab) {
    currentTab = tab;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${tab}`));
    if (tab === 'backups') loadBackups();
    if (tab === 'internet') loadInternet();
    if (tab === 'settings') renderSettings(true);
    if (tab === 'setup') renderSetup();
    if (tab === 'admin') renderAdmin();
    if (tab === 'console') scrollConsole(true);
  }
  document.querySelectorAll('#nav a').forEach((a) => a.addEventListener('click', () => show(a.dataset.tab)));
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) show(go.dataset.go);
  });
  api.on('show-tab', show);
  api.on('open-link', (url) => {
    toast('Opening the sign-in page in your browser…');
    api.openExternal(url);
  });

  // ---------------------------------------------------------------- charts

  const series = { cpu: [], mem: [] };
  function spark(canvas, values, max, color) {
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * ratio;
    canvas.height = h * ratio;
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, w, h);
    if (values.length < 2) return;
    const top = max ? Math.max(max, ...values) : Math.max(...values, 1) * 1.35;
    const step = w / (values.length - 1);
    const y = (v) => h - 4 - (v / top) * (h - 10);
    ctx.beginPath();
    values.forEach((v, i) => (i ? ctx.lineTo(i * step, y(v)) : ctx.moveTo(0, y(v))));
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, color + '55');
    gradient.addColorStop(1, color + '00');
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    values.forEach((v, i) => (i ? ctx.lineTo(i * step, y(v)) : ctx.moveTo(0, y(v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ---------------------------------------------------------------- dashboard

  function renderStatus() {
    const s = state;
    const pill = $('statusPill');
    let text, cls;
    if (!s.installed) { text = 'Not installed'; cls = 'pill big'; }
    else if (s.running) { text = 'Running'; cls = 'pill big ok'; }
    else if (s.desired === 'stopped') { text = 'Stopped'; cls = 'pill big warn'; }
    else { text = 'Not answering'; cls = 'pill big bad'; }
    pill.className = cls;
    pill.innerHTML = `<span class="dot"></span>${text}`;

    const side = $('sideStatus');
    side.className = `side-status ${s.running ? 'up' : s.installed ? 'down' : ''}`;
    side.lastElementChild.textContent = s.running ? `Running · ${duration(s.metrics?.uptimeSec ?? s.health?.uptimeSec)}` : text;
    $('sideVersion').textContent = s.installedVersion ? `Platform ${s.installedVersion}` : `Bundled platform ${s.bundledVersion || '1.0.0'}`;

    $('btnStart').disabled = !s.installed || s.running;
    $('btnStop').disabled = !s.installed || !s.running;
    $('btnRestart').disabled = !s.installed;
    $('rightsNote').classList.toggle('hidden', !s.needsRights);
    $('notInstalled').classList.toggle('hidden', Boolean(s.installed));
    $('dashBody').classList.toggle('hidden', !s.installed);
  }

  function renderDashboard() {
    const s = state;
    const m = s.metrics;
    const h = s.health;
    $('dashTitle').textContent = s.machine?.hostname ? `Alexia on ${s.machine.hostname}` : 'Alexia Guardian platform';
    $('dashSub').textContent = s.running
      ? `Version ${h?.version || '1.0.0'} · up ${duration(m?.uptimeSec ?? h?.uptimeSec)} · ${gatewayText(h?.gateway?.mode)}`
      : s.installed
        ? (s.desired === 'stopped' ? 'Stopped from this manager. It stays off until you start it, or until the PC restarts.' : 'Installed, but not answering on port ' + s.port)
        : 'Not installed on this PC';

    if (m) {
      series.cpu.push(m.cpuPercent);
      series.mem.push(m.rssBytes / 1048576);
      for (const k of ['cpu', 'mem']) if (series[k].length > 90) series[k].shift();
    }
    $('mCpu').textContent = m ? `${m.cpuPercent.toFixed(1)}%` : '—';
    $('mMem').textContent = m ? bytes(m.rssBytes) : '—';
    $('mReq').textContent = m ? String(m.requestsPerMin) : '—';
    $('mLag').textContent = m ? `${m.eventLoopLagMs.toFixed(1)} ms` : '—';
    $('mLagFoot').textContent = m
      ? `${m.eventLoopLagMs < 5 ? 'Instant — nothing waits' : m.eventLoopLagMs < 50 ? 'Fine' : 'Busy — work is queueing'} · peak ${(m.eventLoopLagMaxMs ?? m.eventLoopLagMs).toFixed(1)} ms`
      : 'how long work waits its turn';
    spark($('cCpu'), series.cpu, 100, '#0077b6');
    spark($('cMem'), series.mem, 0, '#00b4d8');
    spark($('cReq'), m?.requestsHistory || [], 0, '#023e8a');

    $('kvPlatform').innerHTML = kv([
      ['Version', h?.version || s.installedVersion || '1.0.0'],
      ['Up for', duration(m?.uptimeSec ?? h?.uptimeSec)],
      ['AI Orchestration', gatewayText(h?.gateway?.mode)],
      ['Audit Ledger', m ? (m.auditVerified ? `Verified (${m.auditRows || 0} blocks)` : 'Tamper warning') : '—'],
      ['Database', m ? bytes(m.dbBytes) : '—'],
      ['Folder', s.root || 'C:\\Alexia', 'path'],
    ]);
    const c = h?.counts || {};
    $('trio').innerHTML = [
      ['Open Incidents', m?.openIncidents ?? c.incidents ?? 0],
      ['Approvals', m?.pendingApprovals ?? c.approvals ?? 0],
      ['Agents', c.agents ?? 5],
    ].map(([label, n]) => `<div><strong>${n ?? '—'}</strong><span>${label}</span></div>`).join('');

    const mc = s.machine || {};
    $('kvMachine').innerHTML = kv([
      ['CPU', mc.cpuPercent != null ? `${mc.cpuPercent}% · ${mc.cores} threads` : '—'],
      ['Memory', mc.totalMem ? `${bytes(mc.totalMem - mc.freeMem)} of ${bytes(mc.totalMem)}` : '—'],
      ['Disk', mc.disk ? `${bytes(mc.disk.freeBytes)} free of ${bytes(mc.disk.totalBytes)}` : '—'],
      ['PC up for', duration(mc.uptimeSec)],
    ]);

    const tailnet = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
    const lan = (mc.lan || []).map((ip) => ({ label: tailnet(ip) ? 'Tailscale · your devices' : 'Wi-Fi / LAN', url: `http://${ip}:${s.port}` }));
    if (s.internetUrl) lan.unshift({ label: 'Internet', url: s.internetUrl });
    lan.push({ label: 'Localhost', url: `http://127.0.0.1:${s.port}` });
    $('addresses').innerHTML = lan.length
      ? lan.map((a) => `<div class="addr"><small>${esc(a.label)}</small><span class="mono">${esc(a.url)}</span><button class="btn ghost sm" data-copy="${esc(a.url)}">Copy</button></div>`).join('')
      : '<p class="faint">No network address.</p>';

    $('kvBackup').innerHTML = kv([
      ['Newest', s.lastBackup ? when(s.lastBackup.createdAt) : 'None yet'],
      ['Kept', String(s.backupCount ?? 0)],
      ['Nightly at', `${s.settings?.ALEXIA_BACKUP_HOUR || 3}:00 IST`],
    ]);
    $('swAuto').checked = s.autostart === 'on';
    $('swAuto').disabled = s.autostart === 'missing';
    $('swManager').checked = Boolean(s.managerAutostart);
  }

  function gatewayText(mode) {
    return {
      live: 'Nebius Nemotron 3 (Live)',
      sandbox: 'Autonomous Sandbox + Demo',
      mock: 'Autonomous Sandbox + Demo',
    }[mode] || 'Autonomous Sandbox + Demo';
  }
  function kv(rows) {
    return rows.map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd>`).join('');
  }

  document.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      api.copy(copy.dataset.copy);
      toast('Copied');
    }
  });
  $('btnStart').addEventListener('click', (e) => busy(e.currentTarget, api.start, 'Starting Alexia…'));
  $('btnStop').addEventListener('click', (e) => {
    if (confirm('Stop Alexia? Guardian agents and the web/mobile console will pause until you start it again.')) {
      busy(e.currentTarget, api.stop, 'Alexia stopped');
    }
  });
  $('btnRestart').addEventListener('click', (e) => busy(e.currentTarget, api.restart, 'Restarting…'));
  $('dashBackup').addEventListener('click', (e) => busy(e.currentTarget, api.backupNow, 'Backup taken'));
  $('swAuto').addEventListener('change', (e) => busy(null, () => api.setAutostart(e.target.checked), e.target.checked ? 'Alexia starts with Windows' : 'Alexia will not start with Windows'));
  $('swManager').addEventListener('change', (e) => busy(null, () => api.setManagerAutostart(e.target.checked), e.target.checked ? 'The manager opens at sign-in' : 'The manager will not open at sign-in'));

  // ---------------------------------------------------------------- console

  const out = $('termOut');
  let filter = 'all';
  const history = [];
  let historyIndex = -1;

  function classify(entry) {
    const t = entry.text;
    if (entry.kind !== 'log') return '';
    if (/\[alert\]|CRITICAL|HIGH/i.test(t)) return 'alert';
    if (/error|fail|fatal|exited with code [1-9]/i.test(t)) return 'err';
    if (/Alexia|Guardian|Uvicorn running|─/i.test(t)) return 'banner';
    return '';
  }
  function lineHtml(entry) {
    const time = new Date(entry.at).toLocaleTimeString([], { hour12: false });
    const kind = entry.kind === 'log' ? '' : `k-${entry.kind}`;
    return `<span class="l ${kind} ${classify(entry)}" data-kind="${entry.kind}"><span class="t">${time}</span>${esc(entry.text)}</span>`;
  }
  function visible(entry) {
    if (filter === 'all') return true;
    if (filter === 'manager') return ['manager', 'command', 'info', 'error', 'watchdog'].includes(entry.kind);
    return entry.kind === filter;
  }
  function appendLines(entries) {
    const html = entries.filter(visible).map(lineHtml).join('');
    if (!html) return;
    out.insertAdjacentHTML('beforeend', html);
    while (out.childElementCount > 3000) out.firstElementChild.remove();
    scrollConsole();
  }
  function scrollConsole(force) {
    if (force || $('follow').checked) out.scrollTop = out.scrollHeight;
  }
  async function reloadConsole() {
    out.innerHTML = '';
    appendLines(await api.consoleHistory());
    scrollConsole(true);
  }
  api.on('console', appendLines);
  api.on('console-clear', () => (out.innerHTML = ''));
  document.querySelectorAll('#consoleFilter .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      filter = chip.dataset.kind;
      document.querySelectorAll('#consoleFilter .chip').forEach((c) => c.classList.toggle('on', c === chip));
      reloadConsole();
    })
  );
  $('termForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('termInput');
    const line = input.value;
    if (!line.trim()) return;
    history.unshift(line);
    historyIndex = -1;
    input.value = '';
    api.command(line);
  });
  $('termInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && history.length) {
      historyIndex = Math.min(history.length - 1, historyIndex + 1);
      e.target.value = history[historyIndex];
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      historyIndex = Math.max(-1, historyIndex - 1);
      e.target.value = historyIndex >= 0 ? history[historyIndex] : '';
      e.preventDefault();
    }
  });
  out.addEventListener('click', () => {
    if (!window.getSelection().toString()) $('termInput').focus();
  });
  $('btnOpenLogs').addEventListener('click', () => api.open('logs'));

  // ---------------------------------------------------------------- backups

  async function loadBackups() {
    const response = await api.backups();
    if (!response.ok) {
      $('backupRows').innerHTML = `<tr><td colspan="5" class="empty">${esc(response.error)}</td></tr>`;
      return;
    }
    const data = response.result;
    const newest = data.backups[0];
    $('backupSub').textContent = `Taken every night at ${data.hour}:00 IST while Guardian agents continue, and kept for ${data.keep} days. Folder: ${data.main}`;
    $('bNewest').textContent = newest ? when(newest.createdAt) : 'None yet';
    $('bNewestFoot').textContent = newest ? `${newest.name} · ${bytes(newest.bytes)}` : 'The first is taken automatically on install.';
    $('bCount').textContent = String(data.backups.length);
    $('bKeepFoot').textContent = `The newest ${data.keep} are kept`;
    $('bCopy').textContent = data.copy ? data.copy : 'Off';
    if (data.copy && data.copyReachable === false) $('bCopy').textContent = `${data.copy} — not found (drive unplugged?)`;
    $('backupRows').innerHTML = data.backups.length
      ? data.backups.map((b) => `<tr>
          <td class="mono">${esc(b.name)}</td>
          <td>${when(b.createdAt)}</td>
          <td class="num">${bytes(b.bytes)}</td>
          <td>${data.copy ? (b.copied ? '<span class="pill ok">Copied</span>' : '<span class="pill warn">Not copied</span>') : '<span class="faint">—</span>'}</td>
          <td><div class="actions"><button class="btn ghost sm" data-restore="${esc(b.name)}">Restore</button><button class="btn danger ghost sm" data-delete="${esc(b.name)}">Delete</button></div></td>
        </tr>`).join('')
      : '<tr><td colspan="5" class="empty">No backups yet. Take one now.</td></tr>';
  }
  $('backupRows').addEventListener('click', async (e) => {
    const restore = e.target.closest('[data-restore]');
    const del = e.target.closest('[data-delete]');
    if (restore) {
      const result = await busy(restore, () => api.restore(restore.dataset.restore));
      if (result?.ok) toast('Restored. Alexia is starting on the backup.');
      loadBackups();
    }
    if (del) {
      await busy(del, () => api.deleteBackup(del.dataset.delete));
      loadBackups();
    }
  });
  $('btnBackupNow').addEventListener('click', async (e) => {
    await busy(e.currentTarget, api.backupNow, 'Backup taken');
    loadBackups();
  });
  $('btnBackupFolder').addEventListener('click', () => api.open('backups'));
  $('btnPickCopy').addEventListener('click', async () => {
    const folder = await api.pickFolder();
    if (!folder) return;
    const result = await busy(null, () => api.saveSettings({ ALEXIA_BACKUP_COPY_DIR: folder }));
    if (result?.ok) {
      toast('Second copy set. Restarting Alexia…');
      await api.restart();
      loadBackups();
    }
  });

  // ---------------------------------------------------------------- guardian console

  let adminSrc = '';
  function renderAdmin() {
    const wrap = $('webwrap');
    const src = `http://127.0.0.1:${state.port || 8080}/`;
    $('adminOff').classList.toggle('hidden', Boolean(state.running));
    let view = wrap.querySelector('webview');
    if (!state.running) {
      if (view) view.remove();
      adminSrc = '';
      return;
    }
    if (!view || adminSrc !== src) {
      if (view) view.remove();
      view = document.createElement('webview');
      view.setAttribute('partition', 'persist:alexia');
      view.setAttribute('src', src);
      wrap.appendChild(view);
      adminSrc = src;
    }
  }
  $('btnAdminReload').addEventListener('click', () => $('webwrap').querySelector('webview')?.reload());
  $('btnAdminBrowser').addEventListener('click', () => api.open('admin'));
  $('btnMerchant').addEventListener('click', () => api.openExternal(`http://127.0.0.1:${state.port || 8080}/docs`));

  // ---------------------------------------------------------------- internet

  async function loadInternet() {
    renderPublic();
    const [ts, cf] = await Promise.all([api.tailscaleStatus(), api.cloudflareStatus()]);
    const steps = [];
    steps.push(step(ts.installed, 'Install Tailscale', 'Free. It makes an outgoing connection, so no router ports are opened.', ts.installed ? null : ['Install', 'tsInstall']));
    const connected = ts.installed && ts.state === 'Running';
    steps.push(step(connected, 'Sign this PC in', connected ? `Connected as ${ts.dnsName || '—'}` : 'Opens the Tailscale sign-in page in your browser.', ts.installed && !connected ? ['Sign in', 'tsConnect'] : null));
    steps.push(step(Boolean(ts.funnelOn), 'Switch Funnel on', ts.funnelOn ? `Serving ${ts.url}` : 'Publishes Alexia\'s HTTPS entrance for your Mobile Companion PWA.', connected ? (ts.funnelOn ? ['Switch off', 'funnelOff', 'ghost'] : ['Switch on', 'funnelOn']) : null));
    steps.push(step(false, 'Stop the key expiring', 'In Tailscale\'s admin page, open this PC and choose "Disable key expiry" — once.', connected ? ['Open Tailscale admin', 'tsAdmin', 'ghost'] : null));
    $('tsSteps').innerHTML = steps.join('');
    $('cfStatus').textContent = cf.installed ? `cloudflared is ${cf.running ? 'running' : 'installed but stopped'}` : '';
  }
  function step(done, title, line, button) {
    return `<li class="${done ? 'done' : ''}"><div><strong>${esc(title)}</strong><small>${esc(line)}</small></div>${button ? `<button class="btn ${button[2] || ''} sm" data-act="${button[1]}">${esc(button[0])}</button>` : ''}</li>`;
  }
  function renderPublic() {
    const url = state.internetUrl;
    const quick = (state.settings || {}).ALEXIA_TUNNEL === 'quick';
    $('publicUrl').textContent = url || (quick ? 'Quick tunnel starting…' : 'Not set up');
    $('btnCopyUrl').disabled = !url;
    $('btnTestUrl').disabled = !url;
    $('qtStatus').textContent = quick ? 'In use. The address changes when the PC restarts.' : '';
    $('btnQuickTunnel').disabled = quick;
  }
  $('btnQuickTunnel').addEventListener('click', (e) => {
    if (!confirm('Use a quick tunnel? Its address changes whenever the PC restarts, and replaces the current internet address.')) return;
    busy(e.currentTarget, api.quickTunnelOn, 'Quick tunnel on. Its address arrives in a few seconds.');
  });
  $('tsSteps').addEventListener('click', async (e) => {
    const button = e.target.closest('[data-act]');
    if (!button) return;
    const act = button.dataset.act;
    if (act === 'tsAdmin') return api.openExternal('https://login.tailscale.com/admin/machines');
    const actions = {
      tsInstall: [api.tailscaleInstall, 'Tailscale installed'],
      tsConnect: [api.tailscaleConnect, 'This PC is signed in to Tailscale'],
      funnelOn: [api.funnelOn, 'Funnel is on. Alexia is online.'],
      funnelOff: [api.funnelOff, 'Funnel is off. Alexia is on your network only.'],
    };
    const [fn, success] = actions[act];
    if (act !== 'funnelOff' || confirm('Switch Funnel off? Devices outside your Wi-Fi will not reach Alexia.')) {
      toast('Working… the Console tab shows the details.');
      await busy(button, fn, success);
      setTimeout(loadInternet, 800);
    }
  });
  $('btnCopyUrl').addEventListener('click', () => {
    api.copy(state.internetUrl);
    toast('Copied');
  });
  $('btnTestUrl').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.classList.add('busy');
    const result = await api.checkPublic(state.internetUrl);
    button.classList.remove('busy');
    $('publicFoot').textContent = result.ok
      ? `Reachable from the internet (${new Date().toLocaleTimeString()}). Open this address on your Mobile Companion PWA.`
      : `Not reachable: ${result.reason || 'HTTP ' + result.status}. Is Funnel or the tunnel on, and Alexia running?`;
    toast(result.ok ? 'Reachable from the internet' : 'Not reachable from the internet', !result.ok);
  });
  $('btnCloudflare').addEventListener('click', (e) =>
    busy(e.currentTarget, () => api.cloudflareSetup($('cfToken').value, $('cfUrl').value), 'Cloudflare Tunnel is set up').then(loadInternet)
  );

  // ---------------------------------------------------------------- settings

  const SETTINGS = [
    ['AI Orchestration (Nebius Token Factory & Tavily)'],
    ['NEBIUS_API_KEY', 'Nebius API Key (NVIDIA Nemotron 3)', 'Leave empty for autonomous sandbox & deterministic fallback mode.', 'password'],
    ['NEBIUS_BASE_URL', 'Nebius Base URL', 'OpenAI-compatible endpoint for Nebius Token Factory.', '', 'https://api.tokenfactory.nebius.com/v1/'],
    ['TAVILY_API_KEY', 'Tavily Search API Key', 'Used by Healer & Sentinel for live CVE and advisory enrichment.', 'password'],
    ['DAILY_USD_BUDGET', 'Daily USD Spend Cap ($)', 'Hard daily model budget enforced by BudgetGuard.', '', '10.00'],
    ['DAILY_TOKEN_BUDGET', 'Daily Token Cap', 'Maximum daily tokens across Nano/Super/Ultra tiers.', '', '5000000'],
    ['Alerts & Heartbeat'],
    ['ALEXIA_ALERT_NTFY', 'ntfy topic address', 'Subscribe to the same topic in the ntfy phone app for Tier 1 alerts.', '', 'https://ntfy.sh/alexia-…'],
    ['ALEXIA_HEARTBEAT_URL', 'Heartbeat (healthchecks.io ping URL)', 'Tells you when this PC loses power or internet.', '', 'https://hc-ping.com/…'],
    ['GITHUB_WEBHOOK_SECRET', 'GitHub Webhook HMAC Secret', 'Verifies X-Hub-Signature-256 on /webhook/github.', 'password'],
    ['Backups'],
    ['ALEXIA_BACKUP_DIR', 'Backup folder', '', 'folder', 'C:\\Alexia\\backups'],
    ['ALEXIA_BACKUP_COPY_DIR', 'Second copy folder', 'A USB drive or a cloud-synced folder.', 'folder', 'off'],
    ['ALEXIA_BACKUP_KEEP', 'Backups kept', '', '', '14'],
    ['ALEXIA_BACKUP_HOUR', 'Nightly backup at (IST hour)', '', '', '3'],
    ['Network'],
    ['PORT', 'Port', 'Web Dashboard, Mobile PWA, and SSE stream port.', '', '8080'],
    ['ALEXIA_INTERNET_URL', 'Internet address', 'Set by the Internet tab.'],
  ];
  let settingsDirty = false;
  function renderSettings(force) {
    if (settingsDirty && !force) return;
    const values = state.settings || {};
    $('settingsWhere').textContent = `Saved to ${state.root || 'C:\\Alexia'}\\app\\.env. Alexia restarts to use them.`;
    const secrets = state.secretsSet || {};
    $('settingsForm').innerHTML = SETTINGS.map((row) => {
      if (row.length === 1) return `<div class="section-title">${esc(row[0])}</div>`;
      const [key, label, hint, type, placeholder] = row;
      const secret = type === 'password';
      const value = secret ? '' : values[key] || '';
      const shown = secret ? (secrets[key] ? 'Saved. Type a new one to replace it.' : 'Not set') : placeholder || '';
      const common = `name="${key}" value="${esc(value)}" placeholder="${esc(shown)}" spellcheck="false"${secret ? ' autocomplete="new-password" data-secret="1"' : ''}`;
      const input = type === 'folder'
        ? `<div class="row"><input ${common}><button type="button" class="btn ghost sm" data-folder="${key}">Choose…</button></div>`
        : `<input ${common} type="${type === 'password' ? 'password' : 'text'}">`;
      return `<div class="field card"><label>${esc(label)}</label>${input}${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
    }).join('');
    settingsDirty = false;
  }
  $('settingsForm').addEventListener('input', () => (settingsDirty = true));
  $('settingsForm').addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-folder]');
    if (!pick) return;
    const folder = await api.pickFolder();
    if (folder) {
      $('settingsForm').querySelector(`[name="${pick.dataset.folder}"]`).value = folder;
      settingsDirty = true;
    }
  });
  $('btnSaveSettings').addEventListener('click', async (e) => {
    const values = {};
    $('settingsForm').querySelectorAll('input[name]').forEach((input) => {
      if (input.dataset.secret) {
        if (input.value.trim()) values[input.name] = input.value.trim();
        return;
      }
      const before = (state.settings || {})[input.name] || '';
      if (input.value !== before) values[input.name] = input.value.trim();
    });
    if (!Object.keys(values).length) return toast('Nothing changed');
    const saved = await busy(e.currentTarget, () => api.saveSettings(values));
    if (saved?.ok) {
      settingsDirty = false;
      await busy(null, api.restart, 'Saved. Alexia is restarting with the new settings.');
    }
  });

  // ---------------------------------------------------------------- setup

  function compareVersions(a, b) {
    const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
    return 0;
  }

  function renderSetup() {
    const s = state;
    const order = s.installed && s.bundledVersion ? compareVersions(s.bundledVersion, s.installedVersion) : 0;
    const upgrade = order > 0;
    const behind = order < 0;
    $('setupTitle').textContent = !s.installed
      ? 'Install Alexia'
      : upgrade
        ? `Upgrade to ${s.bundledVersion}`
        : behind
          ? 'This manager is older than Alexia'
          : `Alexia ${s.installedVersion} is up to date`;
    $('setupLine').textContent = !s.installed
      ? `Installs Alexia DevSecOps Guardian ${s.bundledVersion || '1.0.0'} into ${s.root || 'C:\\Alexia'}, starts it now and with every boot, and adds a 2-minute health watchdog.`
      : upgrade
        ? `This PC runs ${s.installedVersion}. Upgrading keeps every incident, audit block, backup and setting; if the new version does not start, the previous one is put back.`
        : 'Running Setup again repairs the service, firewall rule, and scheduled tasks; all data and settings are kept.';
    $('btnInstall').textContent = !s.installed ? 'Install' : upgrade ? 'Upgrade' : 'Repair';
    $('btnInstall').dataset.behind = behind ? '1' : '';
    $('reqs').innerHTML = [
      ['Alexia Guardian platform', s.bundledVersion ? `${s.bundledVersion} (included)` : '1.0.0 (included)', true],
      ['Standalone server runtime', 'included (AlexiaServer.exe)', true],
      ['SQLite + SHA-256 Audit Ledger', 'built in', true],
      ['Installed on this PC', s.installedVersion || 'not yet', Boolean(s.installedVersion)],
      ['Starts with Windows', s.autostart === 'on' ? 'yes' : s.autostart === 'off' ? 'no' : '—', s.autostart === 'on'],
    ].map(([k, v, ok]) => `<li><span>${esc(k)}</span><span class="pill ${ok ? 'ok' : ''}">${esc(v)}</span></li>`).join('');
  }
  $('btnInstall').addEventListener('click', async (e) => {
    const options = { funnel: $('optFunnel').checked, remoteDesktop: $('optRdp').checked, skipTuning: !$('optTune').checked };
    toast('Setup is running — follow it in the Console.');
    const result = await busy(e.currentTarget, () => api.install(options));
    if (result?.ok) {
      const found = result.result || {};
      const lines = ['<strong>Done.</strong> Alexia DevSecOps Guardian is installed and running.'];
      if (found.adminPassword) lines.push(`First admin: <code>admin@alexia.local</code> / <code>${esc(found.adminPassword)}</code> — Demo operator: <code>demo</code> / <code>alexiaguardian2026</code>`);
      if (found.ntfyTopic) lines.push(`Phone alerts: install the ntfy app and subscribe to <code>${esc(found.ntfyTopic)}</code>.`);
      if (found.internetUrl) lines.push(`Internet address: <code>${esc(found.internetUrl)}</code> — open it on your Mobile Companion.`);
      $('installResult').innerHTML = lines.join('<br>');
      $('installResult').classList.remove('hidden');
      toast('Alexia is installed');
    }
  });
  $('btnGuide').addEventListener('click', () => api.openExternal('https://github.com/niyatijoshi707/Alexia'));

  // ---------------------------------------------------------------- live state

  api.on('state', (next) => {
    state = next;
    renderStatus();
    renderDashboard();
    renderPublic();
    if (currentTab === 'admin') renderAdmin();
    if (currentTab === 'settings') renderSettings(false);
  });

  (async function boot() {
    state = (await api.state()) || {};
    renderStatus();
    renderDashboard();
    await reloadConsole();
    if (!state.installed) show('setup');
  })();
})();
