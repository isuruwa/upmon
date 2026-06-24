/**
 * UpMon Agent
 * ----------------------------------
 * Collects metrics in the background every POLL_INTERVAL_SEC seconds.
 * HTTP /metrics just returns the cached snapshot — no blocking syscalls per request.
 * Auto-registers itself with the upmon server on startup if UPMON_URL and UPMON_PASSWORD are set.
 *
 * Environment variables:
 *   AGENT_PORT          Port to listen on                        (default: 4242)
 *   AGENT_TOKEN         Secret token for auth                    (default: none)
 *   AGENT_NAME          Display name shown in upmon dashboard    (default: hostname)
 *   POLL_INTERVAL_SEC   How often to collect metrics             (default: 15)
 *   UPMON_URL           URL of your upmon server                 (e.g. http://192.168.1.10:3006)
 *   UPMON_PASSWORD      Upmon admin password (for registration)  (default: none)
 *   AGENT_ANNOUNCE_URL  Public URL of this agent (for upmon to reach back) (default: auto-detect)
 */

const express = require('express');
const os = require('os');
const si = require('systeminformation');

const PORT              = Number(process.env.AGENT_PORT  || 4242);
const TOKEN             = process.env.AGENT_TOKEN        || '';
const POLL_INTERVAL_MS  = Number(process.env.POLL_INTERVAL_SEC || 15) * 1000;
const UPMON_URL         = (process.env.UPMON_URL         || '').replace(/\/$/, '');
const UPMON_PASSWORD    = process.env.UPMON_PASSWORD     || '';
const AGENT_NAME        = process.env.AGENT_NAME         || os.hostname();
const AGENT_ANNOUNCE_URL = process.env.AGENT_ANNOUNCE_URL || '';

const app = express();

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!TOKEN) return next();
  if (req.headers['x-agent-token'] !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ─── CPU history ring buffer ──────────────────────────────────────────────────
const cpuHistory = [];

// ─── Cached snapshot ─────────────────────────────────────────────────────────
let cachedMetrics = null;
let collecting = false;

async function collectMetrics() {
  if (collecting) return;
  collecting = true;
  try {
    const [cpuLoad, cpuInfo, mem, disk, netStats, netInterfaces, osInfo, users] = await Promise.all([
      si.currentLoad(),
      si.cpu(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.networkInterfaces(),
      si.osInfo(),
      si.users(),
    ]);

    cpuHistory.push(Math.round(cpuLoad.currentLoad));
    if (cpuHistory.length > 60) cpuHistory.shift();

    const sshSessions = users.filter(u => u.tty && u.tty.startsWith('pts'));

    const interfaces = (Array.isArray(netInterfaces) ? netInterfaces : [netInterfaces])
      .filter(n => n && !n.internal)
      .map(n => ({
        name: n.iface,
        ip4: n.ip4 || null,
        ip6: n.ip6 || null,
        mac: n.mac || null,
        type: n.type || null,
        operstate: n.operstate || 'unknown',
        speed: n.speed || null,
      }));

    const disks = disk
      .filter(d => d.mount && (d.mount === '/' || d.mount.startsWith('/mnt') || d.mount.startsWith('/data')))
      .map(d => ({
        mount: d.mount,
        fs: d.fs,
        size: d.size,
        used: d.used,
        available: d.available,
        use: Math.round(d.use),
      }));

    const netThroughput = (Array.isArray(netStats) ? netStats : [netStats])
      .filter(n => n && n.iface)
      .map(n => ({ iface: n.iface, rx_sec: n.rx_sec, tx_sec: n.tx_sec }));

    cachedMetrics = {
      ts: Date.now(),
      hostname: os.hostname(),
      platform: osInfo.platform,
      distro: osInfo.distro,
      release: osInfo.release,
      kernel: osInfo.kernel,
      arch: osInfo.arch,
      uptime_seconds: os.uptime(),
      cpu: {
        brand: cpuInfo.brand,
        cores: cpuInfo.cores,
        physicalCores: cpuInfo.physicalCores,
        speed: cpuInfo.speed,
        load: Math.round(cpuLoad.currentLoad),
        loadUser: Math.round(cpuLoad.currentLoadUser),
        loadSystem: Math.round(cpuLoad.currentLoadSystem),
        loadAvg: os.loadavg(),
        history: [...cpuHistory],
      },
      memory: {
        total: mem.total,
        used: mem.active,           // actual used — excludes buffers/cache
        usedRaw: mem.used,          // raw OS figure (includes cache)
        buffersCache: mem.used - mem.active,
        free: mem.free,
        available: mem.available,
        usedPercent: Math.round((mem.active / mem.total) * 100),
      },
      disks,
      interfaces,
      net: netThroughput,
      sessions: {
        total: users.length,
        ssh: sshSessions.length,
        users: sshSessions.map(u => ({ user: u.user, ip: u.ip, date: u.date })),
      },
    };
  } catch (err) {
    console.error('Metrics collection error:', err.message);
  } finally {
    collecting = false;
  }
}

// ─── Auto-registration ────────────────────────────────────────────────────────
function getLocalIP() {
  // Pick the first non-internal IPv4 address
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

async function register(retryCount = 0) {
  if (!UPMON_URL || !UPMON_PASSWORD) return;

  const agentUrl = AGENT_ANNOUNCE_URL || `http://${getLocalIP()}:${PORT}`;

  try {
    const res = await fetch(`${UPMON_URL}/api/register-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: UPMON_PASSWORD,
        name: AGENT_NAME,
        agent_url: agentUrl,
        agent_token: TOKEN || undefined,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`✓  Registered with upmon as "${data.name}" (id: ${data.id})`);
      console.log(`   Agent URL: ${agentUrl}\n`);
    } else if (res.status === 401) {
      console.error('✗  Registration failed: wrong UPMON_PASSWORD');
    } else {
      const err = await res.json().catch(() => ({}));
      // 400 with "already exists" type message — already registered, that's fine
      if (err.error && err.error.includes('UNIQUE')) {
        console.log(`✓  Already registered with upmon as "${AGENT_NAME}"\n`);
      } else {
        throw new Error(err.error || `HTTP ${res.status}`);
      }
    }
  } catch (err) {
    const delay = Math.min(30, Math.pow(2, retryCount)) * 1000;
    console.warn(`⚠  Registration failed (${err.message}) — retrying in ${delay / 1000}s...`);
    setTimeout(() => register(retryCount + 1), delay);
  }
}

// ─── Metrics endpoint ─────────────────────────────────────────────────────────
app.get('/metrics', (req, res) => {
  if (!cachedMetrics) return res.status(503).json({ error: 'Metrics not yet collected, retry in a moment' });
  res.json(cachedMetrics);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Start ────────────────────────────────────────────────────────────────────
collectMetrics();
setInterval(collectMetrics, POLL_INTERVAL_MS);

app.listen(PORT, async () => {
  console.log(`\nUpMon Agent running on port ${PORT} (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  if (!TOKEN) {
    console.warn('⚠  AGENT_TOKEN is not set — anyone who can reach this port can read your metrics!');
    console.warn('   Set it via: AGENT_TOKEN=your_secret ./agent-bin\n');
  } else {
    console.log('✓  Token auth enabled');
  }

  if (UPMON_URL && UPMON_PASSWORD) {
    console.log(`→  Registering with upmon at ${UPMON_URL}...`);
    await register();
  } else {
    console.log('ℹ  Auto-registration skipped (set UPMON_URL and UPMON_PASSWORD to enable)\n');
  }
});
