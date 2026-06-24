# UpMon

> Lightweight self-hosted uptime monitor with a public TV/status page, password-protected admin dashboard, remote host metrics via agents, and Telegram alerting. No Docker required — single SQLite file, survives restarts.

---

## Features

- **Public status page** (`/`) — TV-friendly, auto-refreshes via WebSocket, no polling countdown
- **Admin dashboard** (`/admin`) — password-protected, add/edit/delete monitors
- **Per-host metrics dashboard** (`/host/:id`) — live CPU, memory, disk, and network from remote agents
- **Monitor types**: HTTP, TCP port, Ping, PostgreSQL, MySQL, Redis, Disk usage
- **Agent system** — one-command install on any Linux host; agent self-registers and exposes `/metrics`
- **Telegram alerts** — on down/up events with a 5-minute cooldown to prevent spam
- **SQLite persistence** via `better-sqlite3` — no native compile step, works on Node 18+
- **Uptime history** — 24h / 7d / 30d per monitor, check history pruned after 30 days automatically
- **Incident log** — every down period recorded with start/end timestamps

---

## Requirements

- **Node.js 18+** (tested on Node 20 LTS)
- No Docker, no external database required for UpMon itself

Verify your Node version:
```bash
node --version
```

Install or upgrade Node via NodeSource if needed:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Quick Start

```bash
git clone https://github.com/youruser/upmon.git
cd upmon
npm install
ADMIN_PASSWORD=yourpassword PORT=3002 node server.js
```

Open in browser:
- **Status page (TV)**: `http://localhost:3002/`
- **Admin dashboard**: `http://localhost:3002/admin`

On first run, `data/upmon.db` is created automatically. Back this up — it's the only stateful file.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3002` | HTTP port |
| `ADMIN_PASSWORD` | `changeme` | Password for `/admin`. **Always set this.** |
| `SESSION_SECRET` | random per boot | Set a fixed value so sessions survive restarts |
| `DATA_DIR` | `./data` | Directory where `upmon.db` lives |

Create an `upmon.env` file for persistent config:
```env
ADMIN_PASSWORD=something-only-you-know
SESSION_SECRET=some-long-random-string-here
PORT=3002
```

---

## Production Setup with PM2

PM2 is the easiest way to run UpMon in production without systemd — auto-restarts on crash, survives reboots, and gives you log management.

### Install PM2

```bash
npm install -g pm2
```

### Start UpMon with PM2

Using an inline environment:
```bash
pm2 start server.js --name upmon \
  --env production \
  -- \
  PORT=3002

# Or with env vars set before the command:
ADMIN_PASSWORD=yourpassword SESSION_SECRET=yoursecret PORT=3002 \
  pm2 start server.js --name upmon
```

### Recommended: ecosystem config file

Create `ecosystem.config.js` in the project root:

```js
module.exports = {
  apps: [
    {
      name: 'upmon',
      script: './server.js',
      cwd: '/opt/upmon',
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
        ADMIN_PASSWORD: 'change-this-now',
        SESSION_SECRET: 'change-this-long-random-string',
        DATA_DIR: '/opt/upmon/data',
      },
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
      watch: false,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
```

Then start it:
```bash
pm2 start ecosystem.config.js
```

### Survive reboots

```bash
pm2 startup        # generates and prints a command — run that command as root
pm2 save           # saves the current process list
```

### Common PM2 commands

```bash
pm2 list                   # show all processes
pm2 logs upmon             # tail live logs
pm2 logs upmon --lines 100 # last 100 lines
pm2 restart upmon          # restart
pm2 stop upmon             # stop
pm2 delete upmon           # remove from PM2
pm2 monit                  # live dashboard (CPU/memory per process)
```

---

## Agent Setup (Remote Host Monitoring)

The UpMon agent is a small Node.js process that runs on each server you want to monitor. It exposes a `/metrics` endpoint that UpMon polls every 15 seconds.

### Metrics collected by the agent

- CPU load (%), per-core history, load averages, brand/core info
- Memory: total, used, free, swap
- Disk: per-filesystem usage %, read/write speeds
- Network: interface stats, IP addresses, rx/tx rates
- OS info, uptime, logged-in users

### One-command install (run on the target server as root)

```bash
curl -fsSL http://your-upmon-server:3002/install.sh | \
  UPMON_URL="http://your-upmon-server:3002" \
  UPMON_PASSWORD="your-admin-password" \
  bash
```

The script will:
1. Install Node.js 20 LTS if not present (supports `apt` / `dnf` / `yum`)
2. Download `agent.js` from your UpMon server
3. Install npm dependencies
4. Create and start a `systemd` service (`upmon-agent`)
5. Auto-detect the server's IP and register it with UpMon

### Agent install options

| Variable | Default | Description |
|---|---|---|
| `UPMON_URL` | *(required)* | URL of your UpMon server |
| `UPMON_PASSWORD` | *(required)* | Admin password |
| `AGENT_PORT` | `4242` | Port the agent listens on |
| `AGENT_TOKEN` | *(auto-generated)* | Secret token for agent auth |
| `HOST_NAME` | server hostname | Display name in the UpMon UI |
| `AGENT_IP` | *(auto-detected)* | IP UpMon uses to reach the agent |

Custom port and name example:
```bash
curl -fsSL http://your-upmon-server:3002/install.sh | \
  UPMON_URL="http://your-upmon-server:3002" \
  UPMON_PASSWORD="your-admin-password" \
  AGENT_PORT=9000 \
  HOST_NAME="prod-web-01" \
  bash
```

### Manage the agent service

```bash
systemctl status upmon-agent
journalctl -u upmon-agent -f
systemctl restart upmon-agent

# Uninstall
systemctl stop upmon-agent && systemctl disable upmon-agent
rm -rf /opt/upmon-agent /etc/systemd/system/upmon-agent.service
systemctl daemon-reload
```

### Manual agent registration (no install script)

```bash
# On the target server
mkdir -p /opt/upmon-agent && cd /opt/upmon-agent
curl -O http://your-upmon-server:3002/agent/agent.js
curl -O http://your-upmon-server:3002/agent/package.json
npm install --omit=dev
AGENT_TOKEN=your_secret node agent.js

# Register from anywhere
curl -X POST http://your-upmon-server:3002/api/register-agent \
  -H "Content-Type: application/json" \
  -d '{
    "password":    "your-admin-password",
    "name":        "My Server",
    "agent_url":   "http://192.168.1.10:4242",
    "agent_token": "your_secret"
  }'
```

### Firewall

The UpMon server polls the agent — the agent never calls out. Allow only your UpMon server:
```bash
ufw allow from <upmon-server-ip> to any port 4242
```

---

## Monitor Types

| Type | What it checks |
|---|---|
| **HTTP** | URL reachability; any non-4xx/5xx response is up |
| **TCP** | Raw port-open check (SSH, SIP, custom ports, etc.) |
| **Ping** | TCP probe on port 80/443 (no raw ICMP needed) |
| **PostgreSQL** | Connects and runs `SELECT 1` |
| **MySQL** | Connects and runs `SELECT 1` |
| **Redis** | Connects and sends `PING` |
| **Disk** | Local disk % used (remote disk requires an agent) |

---

## Telegram Notifications

1. Go to `/admin` → **Settings** → **Notifications**
2. Enter your Bot Token and Chat ID
3. Click **Test** to verify
4. Save — UpMon will send an alert when any monitor goes down or recovers

Alerts have a 5-minute cooldown per monitor to prevent spam on flapping services. Messages are sent as HTML-formatted Telegram messages.

---

## Adding Monitors

1. Open `/admin` and log in
2. Click **+ Add monitor**
3. Choose a type, set the host/IP, port, and check interval
4. Toggle **Show on public status page** — uncheck for internal-only monitors you don't want on the TV
5. Save — the first check runs immediately

---

## Project Structure

```
upmon/
├── server.js           # Main Express app, WebSocket, check scheduler
├── checkers.js         # Monitor type implementations (HTTP/TCP/PG/MySQL/Redis/Disk)
├── db.js               # SQLite schema, queries, pruning
├── agent.js            # Agent process (runs on monitored hosts)
├── agent-package.json  # Agent dependencies (standalone)
├── install-agent.sh    # One-command agent installer (served at /install.sh)
├── public/
│   ├── status.html     # Public TV status page
│   ├── admin.html      # Admin dashboard
│   └── host.html       # Per-host metrics view
├── upmon.service       # systemd unit file
├── start.sh            # Dev start script (clears SQLite WAL locks)
├── package.json
└── data/
    └── upmon.db        # SQLite database (auto-created, back this up)
```

---

## Backup

The only file you need to back up is `data/upmon.db`:
```bash
cp /opt/upmon/data/upmon.db /your/backup/location/upmon-$(date +%F).db
```

Check history older than 30 days is pruned automatically (hourly). Adjust `pruneOldChecks` in `db.js` for longer retention.

---

## License

ISC
