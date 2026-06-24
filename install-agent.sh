#!/usr/bin/env bash
# =============================================================================
# UpMon Agent - One-command installer
#
# Usage (run on the TARGET server as root):
#
#   curl -fsSL http://your-upmon-server:3002/install.sh | \
#     UPMON_URL="http://your-upmon-server:3002" \
#     UPMON_PASSWORD="your-admin-password" \
#     bash
#
# Optional env vars:
#   AGENT_PORT    Port agent listens on        (default: 4242)
#   AGENT_TOKEN   Secret token for agent auth  (default: auto-generated)
#   HOST_NAME     Display name in upmon UI     (default: server hostname)
#   AGENT_IP      IP upmon uses to reach agent (default: auto-detected)
# =============================================================================
set -euo pipefail

# Colours
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[upmon]${NC} $*"; }
success() { echo -e "${GREEN}[upmon]${NC} v $*"; }
warn()    { echo -e "${YELLOW}[upmon]${NC} ! $*"; }
die()     { echo -e "${RED}[upmon]${NC} x $*" >&2; exit 1; }

# Required vars
[[ -z "${UPMON_URL:-}"      ]] && die "UPMON_URL is required  (e.g. http://your-upmon-server:3002)"
[[ -z "${UPMON_PASSWORD:-}" ]] && die "UPMON_PASSWORD is required"

# Defaults
AGENT_PORT="${AGENT_PORT:-4242}"
AGENT_TOKEN="${AGENT_TOKEN:-$(openssl rand -hex 24 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-')}"
HOST_NAME="${HOST_NAME:-$(hostname -f 2>/dev/null || hostname)}"
INSTALL_DIR="/opt/upmon-agent"
SERVICE_FILE="/etc/systemd/system/upmon-agent.service"

# Auto-prepend http:// if scheme was omitted
[[ "$UPMON_URL" != http://* && "$UPMON_URL" != https://* ]] && UPMON_URL="http://${UPMON_URL}"

# Auto-detect this server's IP (the IP upmon will poll)
if [[ -z "${AGENT_IP:-}" ]]; then
  AGENT_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  [[ -z "$AGENT_IP" ]] && AGENT_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -z "$AGENT_IP" ]] && die "Could not auto-detect server IP. Set AGENT_IP= manually."
fi

AGENT_URL="http://${AGENT_IP}:${AGENT_PORT}"

info "Installing UpMon Agent"
info "  Server : $HOST_NAME  ($AGENT_IP)"
info "  Port   : $AGENT_PORT"
info "  UpMon  : $UPMON_URL"
echo ""

# Must be root
[[ $EUID -ne 0 ]] && die "Run as root (or with sudo bash)."

# ---- Clean up any previous install (makes re-running this script safe) -----
if systemctl list-unit-files 2>/dev/null | grep -q '^upmon-agent\.service'; then
  info "Existing upmon-agent install found - stopping it before reinstalling..."
  systemctl stop upmon-agent 2>/dev/null || true
  systemctl disable upmon-agent 2>/dev/null || true
fi
rm -rf "$INSTALL_DIR"

# ---- Refuse to install if the target port is already taken -----------------
# (Previously the service would just restart-loop forever on EADDRINUSE
#  without ever telling you why - this fails fast with the actual cause.)
if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${AGENT_PORT}\$"; then
  CONFLICT=$(ss -tlnp 2>/dev/null | grep -E "[:.]${AGENT_PORT}[[:space:]]" || true)
  die "Port ${AGENT_PORT} is already in use by another process:\n  ${CONFLICT}\nFree this port first (e.g. 'kill <pid>' after checking what it is with 'ps -p <pid> -o pid,ppid,user,cmd'), or set AGENT_PORT=<other port> and re-run."
fi

# ---- Install Node.js if missing ---------------------------------------------
if ! command -v node &>/dev/null; then
  info "Node.js not found - installing via NodeSource (Node 20 LTS)..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y nodejs >/dev/null
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
    dnf install -y nodejs >/dev/null
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
    yum install -y nodejs >/dev/null
  else
    die "Unsupported package manager. Install Node.js 18+ manually then re-run."
  fi
  success "Node.js $(node -v) installed"
else
  node -e "if(parseInt(process.version.slice(1))<18){process.exit(1)}" \
    || die "Node.js 18+ required. Found $(node -v). Please upgrade."
  success "Node.js $(node -v) already present"
fi

# Detect the actual node binary path AFTER install (varies: /usr/bin, /usr/local/bin, nvm, etc.)
NODE_BIN=$(command -v node) || die "node binary not found after install."
info "  Node   : $NODE_BIN"

# ---- Download agent files from upmon server ---------------------------------
mkdir -p "$INSTALL_DIR"
info "Downloading agent from $UPMON_URL ..."
curl -fsSL "${UPMON_URL}/agent/agent.js"     -o "${INSTALL_DIR}/agent.js"     || die "Failed to download agent.js from ${UPMON_URL}/agent/agent.js"
curl -fsSL "${UPMON_URL}/agent/package.json" -o "${INSTALL_DIR}/package.json" || die "Failed to download package.json"
success "Agent files downloaded to $INSTALL_DIR"

# ---- Install npm dependencies -----------------------------------------------
info "Installing npm dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev --silent
success "Dependencies installed"

# ---- Create systemd service --------------------------------------------------
info "Creating systemd service..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=UpMon Agent
After=network.target

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} agent.js
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5
Environment=AGENT_PORT=${AGENT_PORT}
Environment=AGENT_TOKEN=${AGENT_TOKEN}

[Install]
WantedBy=multi-user.target
EOF

# DynamicUser allocates a transient UID that doesn't own these files, so they
# need to be world-readable for the service to actually start.
chmod -R a+rX "$INSTALL_DIR"

systemctl daemon-reload
systemctl enable upmon-agent >/dev/null 2>&1
systemctl restart upmon-agent

# Wait up to 10s for agent to come up
info "Waiting for agent to start..."
for i in $(seq 1 10); do
  if curl -sf --max-time 2 "${AGENT_URL}/ping" >/dev/null 2>&1; then
    success "Agent is responding at ${AGENT_URL}"
    break
  fi
  sleep 1
  if [[ $i -eq 10 ]]; then
    warn "Agent did not respond after 10s at ${AGENT_URL}/ping"
    if journalctl -u upmon-agent -n 20 --no-pager 2>/dev/null | grep -q EADDRINUSE; then
      warn "Cause: port ${AGENT_PORT} is already in use by another process on this host."
      warn "Find it with:  ss -tlnp | grep ${AGENT_PORT}"
    else
      warn "Check logs: journalctl -u upmon-agent -n 30"
    fi
    warn "Service file: $SERVICE_FILE"
    warn "Node binary : $NODE_BIN"
  fi
done

# ---- Register host with upmon -----------------------------------------------
info "Registering host with upmon..."
RESPONSE=$(curl -sf --max-time 10 \
  -X POST "${UPMON_URL}/api/register-agent" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"${UPMON_PASSWORD}\",\"name\":\"${HOST_NAME}\",\"agent_url\":\"${AGENT_URL}\",\"agent_token\":\"${AGENT_TOKEN}\"}" \
  2>&1) || die "Could not reach upmon at ${UPMON_URL}/api/register-agent\nResponse: $RESPONSE"

HOST_ID=$(echo "$RESPONSE" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [[ -n "$HOST_ID" ]]; then
  success "Host registered! ID: $HOST_ID"
  echo ""
  echo -e "${GREEN}============================================================${NC}"
  echo -e "${GREEN}  UpMon Agent installed and registered successfully!${NC}"
  echo -e "${GREEN}============================================================${NC}"
  echo ""
  echo -e "  Dashboard : ${CYAN}${UPMON_URL}/host/${HOST_ID}${NC}"
  echo -e "  Agent URL : ${CYAN}${AGENT_URL}${NC}"
  echo -e "  Node path : ${CYAN}${NODE_BIN}${NC}"
  echo ""
else
  warn "Server response: $RESPONSE"
  die "Registration failed. Check UPMON_PASSWORD and connectivity to $UPMON_URL"
fi
