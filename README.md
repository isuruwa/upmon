# UpMon

A lightweight, self-hosted uptime monitor: one **public TV/status page** for the office screen,
and one **password-protected admin dashboard** to create/edit monitors. No external services,
no Docker required, single SQLite file for storage — survives restarts.

Inspired by the good parts of Uptime Kuma (clean status page, simple monitor model) and Zabbix
(real persistence, incident tracking) without the operational weight of either.

## Why this rebuild (vs. the old infra-monitor)

The previous version kept everything (`services`, check history) in a plain JS array in RAM.
Every restart, crash, or redeploy wiped all monitors and history — there was no real status
page either (admin and viewer were mixed together in one UI). This version fixes that:

- **SQLite persistence** — monitors, every check, and incidents survive restarts. Uses Node's
  built-in `node:sqlite` module, so there's no native compilation step to fight with on the LXC.
- **Separate public status page (`/`) and admin dashboard (`/admin`)** — the TV only ever shows
  the clean public view; nobody can accidentally edit monitors from the office screen.
- **Real up/down history + uptime %** (24h / 7d / 30d) per monitor, not just "last 20 in RAM."
- **Incident log** — every down period is recorded with start/end time.
- **Password-gated admin** via a single env var, session cookie based.
- **Monitor types**: HTTP, TCP port, Ping (TCP-based reachability), Postgres, Redis, Disk usage.

## Requirements

- Node.js **22.5+** (uses the built-in `node:sqlite` module — no native build tools needed)
- That's it. No Docker, no Postgres/Redis server required for UpMon itself (those are only
  used if you choose to *monitor* a Postgres/Redis target).

Check your Proxmox LXC's Node version:
```bash
node --version
```
If it's older than 22.5, update it (NodeSource setup script, example for Debian/Ubuntu base):
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Setup

```bash
npm install
ADMIN_PASSWORD=your-real-password PORT=3002 node server.js
```

Open:
- **Public status (TV)**: `http://<ip>:3002/`
- **Admin dashboard**: `http://<ip>:3002/admin`

On first run a `data/upmon.db` SQLite file is created automatically — back this up if you care
about historical uptime data (it's the only stateful file in the project).

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3002` | HTTP port |
| `ADMIN_PASSWORD` | `changeme` | Password for `/admin`. **Set this before exposing the box.** |
| `SESSION_SECRET` | random per boot | Set a fixed value if you want sessions to survive a restart |
| `DATA_DIR` | `./data` | Where `upmon.db` lives |

Example `upmon.env` (used by the systemd unit below):
```
ADMIN_PASSWORD=something-only-you-know
SESSION_SECRET=some-long-random-string
PORT=3002
```

## Deploying on your Proxmox LXC (matches your existing UpMon v2 setup)

```bash
# On the LXC
mkdir -p /opt/upmon
# copy the project files into /opt/upmon (scp, git clone, rsync — your call)
cd /opt/upmon
npm install --omit=dev

useradd -r -s /usr/sbin/nologin upmon || true
chown -R upmon:upmon /opt/upmon

cat > /opt/upmon/upmon.env <<'EOF'
ADMIN_PASSWORD=change-this-now
SESSION_SECRET=change-this-too-long-random-string
PORT=3002
EOF
chmod 600 /opt/upmon/upmon.env
chown upmon:upmon /opt/upmon/upmon.env

cp upmon.service /etc/systemd/system/upmon.service
systemctl daemon-reload
systemctl enable --now upmon
systemctl status upmon
```

Logs:
```bash
journalctl -u upmon -f
```

Point the office TV browser at `http://<lxc-ip>:3002/` (kiosk mode / fullscreen browser, auto-refreshes
itself via WebSocket — no manual reload needed, no `Refresh in: 00:03` countdown hack like before).

## Adding monitors

1. Go to `/admin`, log in with `ADMIN_PASSWORD`.
2. Click **+ Add monitor**, choose a type:
   - **HTTP** — checks a URL, considers any non-4xx/5xx (or your chosen exact status) as up
   - **TCP port** — raw port-open check (use for SSH, SIP, custom app ports, etc.)
   - **Ping** — best-effort reachability (TCP probe on 80/443, since raw ICMP needs root)
   - **Postgres** — connects + runs `SELECT 1`
   - **Redis** — connects + `PING`
   - **Disk usage** — local disk % used (remote disk needs an agent; falls back to TCP ping)
3. Set the check interval and whether it should appear on the public status page (uncheck
   "Show on public status page" for anything internal-only you don't want on the TV).
4. Save — it checks immediately, then on the interval you set.

## Notes / limitations

- `node:sqlite` is marked experimental by Node upstream but is stable enough for this workload
  (single-writer, low write volume — a handful of checks per minute). If you'd rather use a
  battle-tested driver, swap `db.js` for `better-sqlite3` (needs build tools / internet access
  to compile on first `npm install`, which is why this default avoids it).
- Old check rows older than 30 days are pruned automatically (hourly) to keep the DB small —
  adjust `pruneOldChecks` in `db.js` if you want longer retention.
- Disk monitoring for **remote** hosts isn't implemented (no agent) — it falls back to a TCP
  reachability check on SSH. If you want real remote disk %, the old README's suggestion stands:
  expose a small `/health` JSON endpoint on the target and we can add an HTTP-based disk checker.
- No email/Telegram/webhook alerting yet (you already have a Telegram flow in your n8n
  FB Autoposter project — say the word and I can wire UpMon's incident events to hit a webhook
  n8n can consume, so down/up events ping your existing Telegram bot).
