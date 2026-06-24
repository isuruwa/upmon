const express = require('express');
const session = require('express-session');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const { db, pruneOldChecks, getSetting, setSetting } = require('./db');
const { runCheck } = require('./checkers');

const PORT = process.env.PORT || 3008;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json());
app.set('trust proxy', 1);

const sessionMw = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000 }
});
app.use(sessionMw);

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ─── Broadcast ───────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
// Cooldown map: monitorId → last notified ts (prevents spam on flapping)
const tgCooldown = new Map();
const TG_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between repeated notifications for same monitor

async function sendTelegram(text, opts = {}) {
  if (getSetting('tg_enabled') !== '1') return;
  const token = getSetting('tg_token');
  const chatId = getSetting('tg_chat_id');
  if (!token || !chatId) return;

  // Respect cooldown per monitor (skip only for recovery messages if cooldown not expired)
  if (opts.monitorId && !opts.isRecovery) {
    const last = tgCooldown.get(opts.monitorId);
    if (last && Date.now() - last < TG_COOLDOWN_MS) return;
  }

  const attempt = async (retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
        });
        const data = await r.json();
        if (data.ok) {
          if (opts.monitorId) tgCooldown.set(opts.monitorId, Date.now());
          return;
        }
        // Non-retryable Telegram errors (bad token, chat not found)
        if ([400, 401, 403].includes(r.status)) {
          console.error('Telegram error (non-retryable):', data.description);
          return;
        }
        throw new Error(data.description || `HTTP ${r.status}`);
      } catch (e) {
        if (i < retries - 1) {
          await new Promise(ok => setTimeout(ok, 1000 * (i + 1)));
        } else {
          console.error('Telegram send failed after retries:', e.message);
        }
      }
    }
  };

  // Fire async — never block the check loop
  attempt().catch(() => {});
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
const timers = new Map();

function rowToMonitor(row) {
  return { ...row, config: JSON.parse(row.config || '{}'), public: !!row.public, paused: !!row.paused };
}

const stmts = {
  getMonitor:       db.prepare('SELECT * FROM monitors WHERE id = ?'),
  insertCheck:      db.prepare('INSERT INTO checks (monitor_id, ts, ok, latency, detail) VALUES (?, ?, ?, ?, ?)'),
  updateMonitor:    db.prepare('UPDATE monitors SET status=?, last_latency=?, last_detail=?, last_checked_at=? WHERE id=?'),
  openIncident:     db.prepare('INSERT INTO incidents (monitor_id, started_at, reason) VALUES (?, ?, ?)'),
  findOpenIncident: db.prepare('SELECT id FROM incidents WHERE monitor_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'),
  closeIncident:    db.prepare('UPDATE incidents SET ended_at=? WHERE id=?'),
};

const pendingWrites = [];
let flushTimer = null;

// ─── KEY FIX: notifications collected outside the synchronous transaction ────
// better-sqlite3 transactions are synchronous. Calling async sendTelegram()
// inside a transaction body means the Promise is silently abandoned — the
// notification never actually fires. We collect notification jobs BEFORE the
// transaction, run the sync DB writes, then dispatch notifications AFTER.
function flushWrites() {
  flushTimer = null;
  if (pendingWrites.length === 0) return;
  const batch = pendingWrites.splice(0);

  // Collect notification jobs first (before the sync transaction)
  const notifications = [];
  for (const w of batch) {
    if (w.prevStatus !== 'down' && w.newStatus === 'down') {
      notifications.push({
        text: `🔴 <b>${escapeHtml(w.monitorName)}</b> is DOWN\n<code>${escapeHtml(w.detail || 'No detail')}</code>\n🕐 ${new Date(w.ts).toUTCString()}`,
        opts: { monitorId: w.monitorId, isRecovery: false },
      });
    } else if (w.prevStatus === 'down' && w.newStatus === 'up') {
      const downTime = w.downSince ? `\n⏱ Down for ${formatDuration(w.ts - w.downSince)}` : '';
      notifications.push({
        text: `✅ <b>${escapeHtml(w.monitorName)}</b> is back UP${downTime}\n🕐 ${new Date(w.ts).toUTCString()}`,
        opts: { monitorId: w.monitorId, isRecovery: true },
      });
    }
  }

  // Sync DB writes
  const txn = db.transaction(() => {
    for (const w of batch) {
      stmts.insertCheck.run(w.monitorId, w.ts, w.ok, w.latency, w.detail);
      stmts.updateMonitor.run(w.newStatus, w.latency, w.detail, w.ts, w.monitorId);
      if (w.prevStatus !== 'down' && w.newStatus === 'down') {
        stmts.openIncident.run(w.monitorId, w.ts, w.detail || 'Down');
      } else if (w.prevStatus === 'down' && w.newStatus === 'up') {
        const open = stmts.findOpenIncident.get(w.monitorId);
        if (open) stmts.closeIncident.run(w.ts, open.id);
      }
    }
  });
  txn();

  // Dispatch notifications AFTER transaction completes
  for (const n of notifications) {
    sendTelegram(n.text, n.opts);
  }
}

async function performCheck(monitorId) {
  const row = stmts.getMonitor.get(monitorId);
  if (!row || row.paused) return;
  const monitor = rowToMonitor(row);
  const result = await runCheck(monitor);
  const ts = Date.now();
  const newStatus = result.ok ? 'up' : 'down';

  // Find open incident start time for duration reporting on recovery
  let downSince = null;
  if (row.status === 'down' && newStatus === 'up') {
    const open = stmts.findOpenIncident.get(monitorId);
    if (open) downSince = open.started_at;
  }

  pendingWrites.push({
    monitorId,
    monitorName: row.name,
    ts,
    ok: result.ok ? 1 : 0,
    latency: result.latency ?? null,
    detail: result.detail ?? null,
    prevStatus: row.status,
    newStatus,
    downSince,
  });

  if (!flushTimer) flushTimer = setTimeout(flushWrites, 500);

  broadcast({ type: 'check', monitorId, status: newStatus, latency: result.latency ?? null, detail: result.detail ?? null, ts });
}

function scheduleMonitor(row, delayMs = 0) {
  if (timers.has(row.id)) { clearInterval(timers.get(row.id)); timers.delete(row.id); }
  if (row.paused) return;
  const sec = Math.max(10, row.interval_sec || 60);
  const handle = setTimeout(() => {
    performCheck(row.id).catch(() => {});
    const t = setInterval(() => performCheck(row.id).catch(() => {}), sec * 1000);
    timers.set(row.id, t);
  }, delayMs);
  timers.set(row.id, handle);
}

function scheduleAll() {
  const rows = db.prepare('SELECT * FROM monitors').all();
  rows.forEach((row, i) => {
    const delay = rows.length > 1 ? Math.floor((i / rows.length) * 60000) : 0;
    scheduleMonitor(row, delay);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

// ─── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed) });
});

// ─── Uptime helpers ──────────────────────────────────────────────────────────
const uptimeStmt = db.prepare('SELECT COUNT(*) AS total, SUM(ok) AS up FROM checks WHERE monitor_id=? AND ts>=?');

function uptimePct(monitorId, sinceMs) {
  const since = Date.now() - sinceMs;
  const row = uptimeStmt.get(monitorId, since);
  if (!row || !row.total) return null;
  return Math.round((row.up / row.total) * 10000) / 100;
}

const historyStmt = db.prepare('SELECT ts, ok, latency FROM checks WHERE monitor_id=? ORDER BY ts DESC LIMIT 50');

function monitorPublicShape(row) {
  const m = rowToMonitor(row);
  const history = historyStmt.all(row.id).reverse();
  return {
    id: m.id, name: m.name, type: m.type, status: m.status,
    last_latency: m.last_latency, last_checked_at: m.last_checked_at,
    group_id: m.group_id, sort_order: m.sort_order,
    uptime24h:  uptimePct(m.id, 24 * 3600 * 1000),
    uptime7d:   uptimePct(m.id, 7 * 24 * 3600 * 1000),
    uptime30d:  uptimePct(m.id, 30 * 24 * 3600 * 1000),
    history
  };
}

function monitorAdminShape(row) {
  return { ...monitorPublicShape(row), ip: row.ip, port: row.port, interval_sec: row.interval_sec,
    config: JSON.parse(row.config || '{}'), public: !!row.public, paused: !!row.paused, last_detail: row.last_detail };
}

// ─── Public API (status page) ────────────────────────────────────────────────
app.get('/api/public/status', (req, res) => {
  const groups = db.prepare('SELECT * FROM groups ORDER BY sort_order, id').all();
  const rows = db.prepare('SELECT * FROM monitors WHERE public=1 ORDER BY sort_order, id').all();
  const monitors = rows.map(monitorPublicShape);
  const overall = monitors.length === 0 ? 'unknown' : monitors.some(m => m.status === 'down') ? 'down' : 'up';
  res.json({ groups, monitors, overall, serverTime: Date.now() });
});

// ─── Admin API (auth required) ───────────────────────────────────────────────
app.get('/api/monitors', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM monitors ORDER BY sort_order, id').all();
  res.json(rows.map(monitorAdminShape));
});

app.post('/api/monitors', requireAuth, (req, res) => {
  const { name, type, ip, port, interval_sec, config, group_id, public: isPublic } = req.body || {};
  if (!name || !type || !ip) return res.status(400).json({ error: 'name, type, ip are required' });
  const info = db.prepare(`INSERT INTO monitors (name, type, ip, port, interval_sec, config, group_id, public)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    name, type, ip, port ? Number(port) : null, Number(interval_sec) || 60,
    JSON.stringify(config || {}), group_id || null, isPublic === false ? 0 : 1
  );
  const row = db.prepare('SELECT * FROM monitors WHERE id=?').get(info.lastInsertRowid);
  scheduleMonitor(row, 0);
  performCheck(row.id).catch(() => {});
  broadcast({ type: 'monitor_added', monitor: monitorAdminShape(row) });
  res.json(monitorAdminShape(row));
});

app.patch('/api/monitors/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM monitors WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const fields = req.body || {};
  const merged = {
    name: fields.name ?? existing.name,
    type: fields.type ?? existing.type,
    ip: fields.ip ?? existing.ip,
    port: fields.port !== undefined ? (fields.port ? Number(fields.port) : null) : existing.port,
    interval_sec: fields.interval_sec !== undefined ? Number(fields.interval_sec) : existing.interval_sec,
    config: fields.config !== undefined ? JSON.stringify(fields.config) : existing.config,
    group_id: fields.group_id !== undefined ? fields.group_id : existing.group_id,
    public: fields.public !== undefined ? (fields.public ? 1 : 0) : existing.public,
    paused: fields.paused !== undefined ? (fields.paused ? 1 : 0) : existing.paused,
    sort_order: fields.sort_order !== undefined ? Number(fields.sort_order) : existing.sort_order,
  };
  db.prepare(`UPDATE monitors SET name=?, type=?, ip=?, port=?, interval_sec=?, config=?, group_id=?, public=?, paused=?, sort_order=? WHERE id=?`)
    .run(merged.name, merged.type, merged.ip, merged.port, merged.interval_sec, merged.config, merged.group_id, merged.public, merged.paused, merged.sort_order, id);
  const row = db.prepare('SELECT * FROM monitors WHERE id=?').get(id);
  scheduleMonitor(row, 0);
  broadcast({ type: 'monitor_updated', monitor: monitorAdminShape(row) });
  res.json(monitorAdminShape(row));
});

app.delete('/api/monitors/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (timers.has(id)) { clearInterval(timers.get(id)); timers.delete(id); }
  db.prepare('DELETE FROM monitors WHERE id=?').run(id);
  tgCooldown.delete(id);
  broadcast({ type: 'monitor_removed', id });
  res.json({ ok: true });
});

app.post('/api/monitors/:id/check', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM monitors WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  await performCheck(id);
  flushWrites();
  res.json(monitorAdminShape(db.prepare('SELECT * FROM monitors WHERE id=?').get(id)));
});

app.post('/api/check-all', requireAuth, async (req, res) => {
  const rows = db.prepare('SELECT * FROM monitors WHERE paused=0').all();
  await Promise.all(rows.map(r => performCheck(r.id)));
  flushWrites();
  res.json({ ok: true, count: rows.length });
});

app.get('/api/monitors/:id/incidents', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare('SELECT * FROM incidents WHERE monitor_id=? ORDER BY started_at DESC LIMIT 50').all(id);
  res.json(rows);
});

// Groups
app.get('/api/groups', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM groups ORDER BY sort_order, id').all());
});
app.post('/api/groups', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO groups (name) VALUES (?)').run(name);
  res.json(db.prepare('SELECT * FROM groups WHERE id=?').get(info.lastInsertRowid));
});
app.delete('/api/groups/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE monitors SET group_id=NULL WHERE group_id=?').run(req.params.id);
  db.prepare('DELETE FROM groups WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Settings (Telegram, etc.) ────────────────────────────────────────────────
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({
    tg_token:        getSetting('tg_token', ''),
    tg_chat_id:      getSetting('tg_chat_id', ''),
    tg_enabled:      getSetting('tg_enabled', '0'),
    tg_cooldown_min: getSetting('tg_cooldown_min', '5'),
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { tg_token, tg_chat_id, tg_enabled, tg_cooldown_min } = req.body || {};
  if (tg_token        !== undefined) setSetting('tg_token',        tg_token);
  if (tg_chat_id      !== undefined) setSetting('tg_chat_id',      tg_chat_id);
  if (tg_enabled      !== undefined) setSetting('tg_enabled',      tg_enabled ? '1' : '0');
  if (tg_cooldown_min !== undefined) setSetting('tg_cooldown_min', String(Number(tg_cooldown_min) || 5));
  res.json({ ok: true });
});

app.post('/api/settings/test-telegram', requireAuth, async (req, res) => {
  const { tg_token, tg_chat_id } = req.body || {};
  const token  = tg_token  || getSetting('tg_token');
  const chatId = tg_chat_id || getSetting('tg_chat_id');
  if (!token || !chatId) return res.status(400).json({ error: 'Token and Chat ID required' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: '✅ <b>UpMon</b> Telegram notifications are working!', parse_mode: 'HTML' }),
    });
    const data = await r.json();
    if (!data.ok) return res.status(400).json({ error: data.description || 'Telegram API error' });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─── Host Agent API ───────────────────────────────────────────────────────────
async function fetchAgentMetrics(host) {
  const url = host.agent_url.replace(/\/$/, '') + '/metrics';
  const headers = host.agent_token ? { 'x-agent-token': host.agent_token } : {};
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`Agent returned ${r.status}`);
    return await r.json();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

app.get('/api/hosts', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, name, agent_url, last_seen_at FROM hosts ORDER BY id').all();
  res.json(rows);
});

app.post('/api/hosts', requireAuth, (req, res) => {
  const { name, agent_url, agent_token } = req.body || {};
  if (!name || !agent_url) return res.status(400).json({ error: 'name and agent_url required' });
  const info = db.prepare('INSERT INTO hosts (name, agent_url, agent_token) VALUES (?,?,?)').run(name, agent_url, agent_token || null);
  res.json(db.prepare('SELECT id, name, agent_url, last_seen_at FROM hosts WHERE id=?').get(info.lastInsertRowid));
});

app.patch('/api/hosts/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM hosts WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, agent_url, agent_token } = req.body || {};
  const newName  = name      ?? existing.name;
  const newUrl   = agent_url ?? existing.agent_url;
  const newToken = agent_token !== undefined && agent_token !== ''
    ? agent_token
    : existing.agent_token;
  db.prepare('UPDATE hosts SET name=?, agent_url=?, agent_token=? WHERE id=?')
    .run(newName, newUrl, newToken, id);
  const host = db.prepare('SELECT id, name, agent_url, last_seen_at FROM hosts WHERE id=?').get(id);
  broadcast({ type: 'agent_updated', host });
  res.json(host);
});

app.delete('/api/hosts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM hosts WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/hosts/:id/metrics', requireAuth, async (req, res) => {
  const host = db.prepare('SELECT * FROM hosts WHERE id=?').get(Number(req.params.id));
  if (!host) return res.status(404).json({ error: 'Host not found' });

  if (host.last_metrics && host.last_seen_at && (Date.now() - host.last_seen_at) < 12000) {
    return res.json(JSON.parse(host.last_metrics));
  }

  try {
    const metrics = await fetchAgentMetrics(host);
    db.prepare('UPDATE hosts SET last_seen_at=?, last_metrics=? WHERE id=?')
      .run(Date.now(), JSON.stringify(metrics), host.id);
    res.json(metrics);
  } catch (err) {
    if (host.last_metrics) return res.json({ ...JSON.parse(host.last_metrics), stale: true });
    res.status(502).json({ error: 'Agent unreachable: ' + err.message });
  }
});

// ─── Agent self-registration ──────────────────────────────────────────────────
app.post('/api/register-agent', (req, res) => {
  const { password, name, agent_url, agent_token } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  if (!name || !agent_url) return res.status(400).json({ error: 'name and agent_url required' });

  const existing = db.prepare('SELECT id FROM hosts WHERE agent_url=?').get(agent_url);
  if (existing) {
    db.prepare('UPDATE hosts SET name=?, agent_token=?, last_seen_at=? WHERE id=?')
      .run(name, agent_token || null, Date.now(), existing.id);
    const host = db.prepare('SELECT id, name, agent_url, last_seen_at FROM hosts WHERE id=?').get(existing.id);
    broadcast({ type: 'agent_updated', host });
    return res.json(host);
  }

  const info = db.prepare('INSERT INTO hosts (name, agent_url, agent_token) VALUES (?,?,?)')
    .run(name, agent_url, agent_token || null);
  const host = db.prepare('SELECT id, name, agent_url, last_seen_at FROM hosts WHERE id=?')
    .get(info.lastInsertRowid);
  broadcast({ type: 'agent_registered', host });
  res.json(host);
});

// ─── Install command endpoint ─────────────────────────────────────────────────
app.get('/api/install-cmd', requireAuth, (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const base  = `${proto}://${host}`;
  const token = req.query.token || 'changeme';
  const name  = req.query.name  || 'my-server';
  const installMode = req.query.mode || 'script'; // 'script' or 'binary'

  const scriptCmd = `curl -fsSL ${base}/install.sh | AGENT_TOKEN=${token} UPMON_URL=${base} UPMON_PASSWORD=${ADMIN_PASSWORD} AGENT_NAME="${name}" bash`;

  const binaryCmd = `curl -fsSL ${base}/install-binary.sh | AGENT_TOKEN=${token} UPMON_URL=${base} UPMON_PASSWORD=${ADMIN_PASSWORD} AGENT_NAME="${name}" bash`;

  const systemd = `[Unit]
Description=UpMon Agent
After=network.target

[Service]
ExecStart=/usr/local/bin/upmon-agent
Environment=AGENT_TOKEN=${token}
Environment=UPMON_URL=${base}
Environment=UPMON_PASSWORD=${ADMIN_PASSWORD}
Environment=AGENT_NAME=${name}
Environment=AGENT_PORT=4242
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target`;

  res.json({ scriptCmd, binaryCmd, systemd, base, token });
});

// ─── Serve agent files ────────────────────────────────────────────────────────
app.get('/agent/agent.js',    (req, res) => res.sendFile(path.join(__dirname, 'agent.js')));
app.get('/agent/package.json',(req, res) => res.sendFile(path.join(__dirname, 'agent-package.json')));
app.get('/install.sh',        (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'install-agent.sh'));
});
app.get('/install-binary.sh', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'install-agent-binary.sh'));
});
app.get('/agent-bin', (req, res) => {
  const fs = require('fs');
  // Support arch param: ?arch=x64 (default), ?arch=arm64
  const arch = req.query.arch === 'arm64' ? 'arm64' : 'x64';
  const binPath = path.join(__dirname, `agent-bin-${arch}`);
  const binPathDefault = path.join(__dirname, 'agent-bin');
  if (fs.existsSync(binPath)) return res.download(binPath, `upmon-agent-linux-${arch}`);
  if (arch === 'x64' && fs.existsSync(binPathDefault)) return res.download(binPathDefault, 'upmon-agent');
  res.status(404).json({ error: `Binary not compiled for ${arch}. Run: pkg agent.js --targets node18-linux-${arch} --output agent-bin-${arch}` });
});

// ─── Static pages ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/host/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));

// ─── WebSocket ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
scheduleAll();
setInterval(pruneOldChecks, 24 * 3600 * 1000);

server.listen(PORT, () => {
  console.log(`\nUpMon running → http://localhost:${PORT}  (admin: /admin)\n`);
  if (ADMIN_PASSWORD === 'changeme') {
    console.warn('⚠  ADMIN_PASSWORD is using the default "changeme" — set it via env var before exposing this.');
  }
});
