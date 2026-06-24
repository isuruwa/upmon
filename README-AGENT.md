# UpMon Agent — One-Command Install

The agent is a tiny Node.js process that runs on each server you want to monitor.
It exposes a `/metrics` endpoint that your upmon server polls every 15 seconds.

---

## Quick install (one command)

Run this **on the target server** as root:

```bash
curl -fsSL http://your-upmon-server:3002/install.sh | \
  UPMON_URL="http://your-upmon-server:3002" \
  UPMON_PASSWORD="your-admin-password" \
  bash
```

That's it. The script will:
1. Install Node.js 20 LTS if not present (supports apt/dnf/yum)
2. Download `agent.js` from your upmon server
3. Install npm dependencies
4. Create and start a `systemd` service (`upmon-agent`)
5. Auto-detect the server's IP and register it with upmon
6. Print a direct link to the host dashboard

### Optional environment variables

| Variable          | Default            | Description                                      |
|-------------------|--------------------|--------------------------------------------------|
| `UPMON_URL`       | *(required)*       | URL of your upmon server                         |
| `UPMON_PASSWORD`  | *(required)*       | Admin password for upmon                         |
| `AGENT_PORT`      | `4242`             | Port the agent listens on                        |
| `AGENT_TOKEN`     | *(auto-generated)* | Secret token for agent auth (random if not set)  |
| `HOST_NAME`       | server hostname    | Display name shown in the upmon UI               |
| `AGENT_IP`        | *(auto-detected)*  | IP upmon uses to reach this agent                |

### Custom port or name example

```bash
curl -fsSL http://your-upmon-server:3002/install.sh | \
  UPMON_URL="http://your-upmon-server:3002" \
  UPMON_PASSWORD="your-admin-password" \
  AGENT_PORT=9000 \
  HOST_NAME="prod-web-01" \
  bash
```

---

## Manage the agent service

```bash
# Status
systemctl status upmon-agent

# Logs
journalctl -u upmon-agent -f

# Restart
systemctl restart upmon-agent

# Uninstall
systemctl stop upmon-agent
systemctl disable upmon-agent
rm -rf /opt/upmon-agent /etc/systemd/system/upmon-agent.service
systemctl daemon-reload
```

---

## Manual install (without the script)

If you prefer to install manually:

```bash
# 1. On the target server
mkdir -p /opt/upmon-agent && cd /opt/upmon-agent
curl -O http://your-upmon-server:3002/agent/agent.js
curl -O http://your-upmon-server:3002/agent/package.json
npm install --omit=dev
AGENT_TOKEN=your_secret node agent.js

# 2. Register the host (from anywhere)
curl -X POST http://your-upmon-server:3002/api/register-agent \
  -H "Content-Type: application/json" \
  -d '{
    "password":    "your-admin-password",
    "name":        "My Server",
    "agent_url":   "http://192.168.1.10:4242",
    "agent_token": "your_secret"
  }'
```

No session cookie needed — `/api/register-agent` takes the admin password directly.

---

## Firewall

The upmon server needs to reach the agent's port. The agent never calls out.

```bash
# Allow only your upmon server
ufw allow from <upmon-server-ip> to any port 4242
```

---

## Environment variables (agent)

| Variable     | Default  | Description                                |
|--------------|----------|--------------------------------------------|
| `AGENT_PORT` | `4242`   | Port the agent listens on                  |
| `AGENT_TOKEN`| *(none)* | Auth token. Always set this in production! |
