const net = require('net');
const http = require('http');
const https = require('https');
const { Client: PgClient } = require('pg');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const fs = require('fs');

function checkTcp(ip, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve(r); };
    sock.setTimeout(timeoutMs);
    sock.connect(port, ip, () => finish({ ok: true, latency: Date.now() - start, detail: 'Port open' }));
    sock.on('error', (e) => finish({ ok: false, latency: Date.now() - start, detail: e.message }));
    sock.on('timeout', () => finish({ ok: false, latency: timeoutMs, detail: 'Connection timeout' }));
  });
}

function checkHttp(ip, port, opts = {}, timeoutMs = 8000) {
  const start = Date.now();
  const p = opts.path || '/';
  const useHttps = !!opts.https || port === 443;
  const mod = useHttps ? https : http;
  const portStr = port ? `:${port}` : '';
  const url = `${useHttps ? 'https' : 'http'}://${ip}${portStr}${p}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    const req = mod.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      const latency = Date.now() - start;
      res.resume();
      const expect = opts.expectStatus;
      const ok = expect ? res.statusCode === Number(expect) : res.statusCode < 400;
      finish({ ok, latency, detail: `HTTP ${res.statusCode}` });
    });
    req.on('error', (e) => finish({ ok: false, latency: Date.now() - start, detail: e.message }));
    req.on('timeout', () => { req.destroy(); finish({ ok: false, latency: timeoutMs, detail: 'Request timeout' }); });
  });
}

async function checkPostgres(ip, port, config = {}) {
  const start = Date.now();
  const client = new PgClient({
    host: ip, port: port || 5432,
    user: config.user || 'postgres',
    password: config.password || '',
    database: config.database || 'postgres',
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return { ok: true, latency: Date.now() - start, detail: 'Query OK' };
  } catch (e) {
    try { await client.end(); } catch (_) {}
    return { ok: false, latency: Date.now() - start, detail: (e.message || 'Connection failed').split('\n')[0] };
  }
}

async function checkMysql(ip, port, config = {}) {
  const start = Date.now();
  let conn;
  try {
    conn = await mysql.createConnection({
      host: ip, port: port || 3306,
      user: config.user || 'root',
      password: config.password || '',
      database: config.database || undefined,
      connectTimeout: 5000,
    });
    await conn.query('SELECT 1');
    await conn.end();
    return { ok: true, latency: Date.now() - start, detail: 'Query OK' };
  } catch (e) {
    if (conn) { try { await conn.end(); } catch (_) {} }
    return { ok: false, latency: Date.now() - start, detail: (e.message || 'Connection failed').split('\n')[0] };
  }
}

function checkRedis(ip, port, config = {}) {
  const start = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const redis = new Redis({
      host: ip, port: port || 6379,
      password: config.password || undefined,
      connectTimeout: 5000,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const finish = (r) => { if (done) return; done = true; redis.disconnect(); resolve(r); };
    redis.connect()
      .then(() => redis.ping())
      .then((res) => finish({ ok: true, latency: Date.now() - start, detail: `PONG (${res})` }))
      .catch((e) => finish({ ok: false, latency: Date.now() - start, detail: (e.message || 'error').split('\n')[0] }));
    setTimeout(() => finish({ ok: false, latency: Date.now() - start, detail: 'Connection timeout' }), 5500);
  });
}

async function checkDisk(ip, port, config = {}) {
  if (ip === 'localhost' || ip === '127.0.0.1') {
    try {
      // Use statfs via fs (Node 18+) — avoids extra dependency / stale package issues
      const stats = fs.statfsSync(config.path || '/');
      const total = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      const usedPct = Math.round(((total - free) / total) * 100);
      const threshold = config.threshold || 90;
      const ok = usedPct < threshold;
      return { ok, latency: 0, detail: `${usedPct}% used (threshold ${threshold}%)`, extra: { usedPct } };
    } catch (e) {
      return { ok: false, latency: 0, detail: e.message };
    }
  }
  const result = await checkTcp(ip, port || 22);
  return { ...result, detail: result.ok ? 'Host reachable (remote disk needs agent)' : result.detail };
}

function checkPing(ip) {
  // TCP-based reachability check on common ports as a simple "is it alive" probe
  // avoids needing raw ICMP sockets / root privileges
  return checkTcp(ip, 80, 3000).then(r => r.ok ? r : checkTcp(ip, 443, 3000));
}

async function runCheck(monitor) {
  const config = typeof monitor.config === 'string' ? JSON.parse(monitor.config || '{}') : (monitor.config || {});
  try {
    switch (monitor.type) {
      case 'http':     return await checkHttp(monitor.ip, monitor.port, config);
      case 'postgres': return await checkPostgres(monitor.ip, monitor.port, config);
      case 'mysql':    return await checkMysql(monitor.ip, monitor.port, config);
      case 'redis':    return await checkRedis(monitor.ip, monitor.port, config);
      case 'disk':     return await checkDisk(monitor.ip, monitor.port, config);
      case 'ping':     return await checkPing(monitor.ip);
      case 'tcp':
      default:         return await checkTcp(monitor.ip, monitor.port);
    }
  } catch (e) {
    return { ok: false, latency: 0, detail: e.message || 'Check failed' };
  }
}

module.exports = { runCheck };
