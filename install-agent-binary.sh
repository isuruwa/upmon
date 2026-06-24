#!/usr/bin/env bash
# =============================================================================
# UpMon Agent - One-line binary installer
#
#   curl -fsSL http://YOUR-UPMON:3006/install-binary.sh | \
#     UPMON_URL="http://YOUR-UPMON:3006" \
#     UPMON_PASSWORD="your-admin-password" \
#     bash
#
# Optional:
#   AGENT_PORT=4242   AGENT_TOKEN=secret   AGENT_NAME=my-server
#   AGENT_IP=1.2.3.4  ARCH=x64|arm64
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[upmon]${NC} $*"; }
success() { echo -e "${GREEN}[upmon]${NC} ✓ $*"; }
warn()    { echo -e "${YELLOW}[upmon]${NC} ⚠ $*"; }
die()     { echo -e "${RED}[upmon]${NC} ✗ $*" >&2; exit 1; }

# ── Validate required vars ──
[[ -z "${UPMON_URL:-}"      ]] && die "UPMON_URL is required   (e.g. http://192.168.1.10:3006)"
[[ -z "${UPMON_PASSWORD:-}" ]] && die "UPMON_PASSWORD is required"
[[ $EUID -ne 0 ]]              && die "Run as root (sudo bash)"

[[ "$UPMON_URL" != http://* && "$UPMON_URL" != https://* ]] && UPMON_URL="http://${UPMON_URL}"
UPMON_URL="${UPMON_URL%/}"

# ── Defaults ──
AGENT_PORT="${AGENT_PORT:-4242}"
AGENT_NAME="${AGENT_NAME:-$(hostname -f 2>/dev/null || hostname)}"
INSTALL_DIR="/opt/upmon-agent"
BIN_PATH="/usr/local/bin/upmon-agent"
ENV_FILE="/etc/upmon-agent.env"
SERVICE_FILE="/etc/systemd/system/upmon-agent.service"

# ── Token: reuse existing if present ──
if [[ -f "$ENV_FILE" ]]; then
  EXISTING_TOKEN=$(grep '^AGENT_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
fi
if [[ -z "${AGENT_TOKEN:-}" && -n "${EXISTING_TOKEN:-}" ]]; then
  AGENT_TOKEN="$EXISTING_TOKEN"
  info "Reusing existing agent token"
else
  AGENT_TOKEN="${AGENT_TOKEN:-$(openssl rand -hex 24 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-')}"
fi

# ── Auto-detect arch ──
if [[ -z "${ARCH:-}" ]]; then
  case "$(uname -m)" in
    x86_64)  ARCH="x64"   ;;
    aarch64) ARCH="arm64" ;;
    armv7l)  ARCH="armv7" ;;
    *) die "Unsupported arch: $(uname -m). Set ARCH=x64|arm64 manually." ;;
  esac
fi

# ── Auto-detect server IP ──
if [[ -z "${AGENT_IP:-}" ]]; then
  AGENT_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '/src/{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
  [[ -z "$AGENT_IP" ]] && AGENT_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -z "$AGENT_IP" ]] && die "Cannot detect server IP. Set AGENT_IP= manually."
fi
AGENT_URL="http://${AGENT_IP}:${AGENT_PORT}"

echo ""
info "─── UpMon Agent Installer ───────────────────────────────"
info "  Server  : $AGENT_NAME  ($AGENT_IP)"
info "  Port    : $AGENT_PORT"
info "  Arch    : $ARCH"
info "  UpMon   : $UPMON_URL"
echo ""

# ── Port conflict check ──
if command -v ss &>/dev/null; then
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${AGENT_PORT}$"; then
    # If it's our own service, that's fine
    if ! systemctl is-active --quiet upmon-agent 2>/dev/null; then
      die "Port ${AGENT_PORT} already in use. Free it or set AGENT_PORT=<other>."
    fi
  fi
fi

# ── Stop existing service if running ──
if systemctl list-unit-files 2>/dev/null | grep -q '^upmon-agent\.service'; then
  info "Stopping existing upmon-agent service..."
  systemctl stop upmon-agent 2>/dev/null || true
fi

# ── Download binary ──
mkdir -p "$INSTALL_DIR"
info "Downloading agent binary (linux-${ARCH})..."
HTTP_CODE=$(curl -fsSL --max-time 90 --write-out "%{http_code}" \
  "${UPMON_URL}/agent-bin" -o "${INSTALL_DIR}/upmon-agent")

if [[ "$HTTP_CODE" == "404" ]]; then
  die "Binary not found at ${UPMON_URL}/agent-bin\nAsk your admin to compile:\n  cd ~/upmon && npx pkg agent.js --targets node18-linux-${ARCH} --output agent"
elif [[ "$HTTP_CODE" != "200" ]]; then
  die "Download failed (HTTP $HTTP_CODE)"
fi

# Verify it's a real binary not an HTML error page
if file "${INSTALL_DIR}/upmon-agent" 2>/dev/null | grep -qi 'html\|text'; then
  die "Downloaded file appears to be HTML, not a binary. Check ${UPMON_URL}/agent-bin"
fi

chmod +x "${INSTALL_DIR}/upmon-agent"
ln -sf "${INSTALL_DIR}/upmon-agent" "$BIN_PATH"
success "Binary installed → $BIN_PATH"

# ── Write env file (preserves token across reinstalls) ──
cat > "$ENV_FILE" << EOF
AGENT_PORT=${AGENT_PORT}
AGENT_TOKEN=${AGENT_TOKEN}
AGENT_NAME=${AGENT_NAME}
UPMON_URL=${UPMON_URL}
EOF
chmod 600 "$ENV_FILE"
success "Config saved → $ENV_FILE"

# ── Install systemd service ──
info "Installing systemd service..."
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=UpMon Agent
Documentation=${UPMON_URL}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${BIN_PATH}
Restart=always
RestartSec=5
StartLimitIntervalSec=120
StartLimitBurst=5

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
EOF

chmod -R a+rX "$INSTALL_DIR"
systemctl daemon-reload
systemctl enable upmon-agent >/dev/null 2>&1
systemctl restart upmon-agent
success "Service enabled and started (survives reboots + Ctrl+C)"

# ── Wait for agent to respond ──
info "Waiting for agent to start..."
STARTED=0
for i in $(seq 1 12); do
  if curl -sf --max-time 3 -H "x-agent-token: ${AGENT_TOKEN}" "${AGENT_URL}/ping" >/dev/null 2>&1; then
    STARTED=1; break
  fi
  sleep 1
done

if [[ $STARTED -eq 0 ]]; then
  warn "Agent didn't respond after 12s. Checking logs:"
  journalctl -u upmon-agent -n 10 --no-pager 2>/dev/null || true
  warn "Continuing with registration anyway..."
fi

# ── Register with UpMon ──
info "Registering with UpMon server..."
REG=$(curl -sf --max-time 15 \
  -X POST "${UPMON_URL}/api/register-agent" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"${UPMON_PASSWORD}\",\"name\":\"${AGENT_NAME}\",\"agent_url\":\"${AGENT_URL}\",\"agent_token\":\"${AGENT_TOKEN}\"}" \
  2>&1) || die "Could not reach UpMon at ${UPMON_URL}/api/register-agent\nIs UpMon running?"

HOST_ID=$(echo "$REG" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

if [[ -n "$HOST_ID" ]]; then
  echo ""
  echo -e "${GREEN}${BOLD}════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  ✓  UpMon Agent installed & registered!${NC}"
  echo -e "${GREEN}${BOLD}════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "  Dashboard : ${CYAN}${UPMON_URL}/host/${HOST_ID}${NC}"
  echo -e "  Agent URL : ${CYAN}${AGENT_URL}${NC}"
  echo -e "  Service   : systemctl status upmon-agent"
  echo ""
  echo -e "  ${YELLOW}Token saved in ${ENV_FILE}${NC}"
  echo -e "  ${YELLOW}Reinstalling later will reuse the same token${NC}"
  echo ""
else
  warn "Registration response: $REG"
  die "Registration failed. Check UPMON_PASSWORD."
fi
