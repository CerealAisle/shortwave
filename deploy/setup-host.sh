#!/usr/bin/env bash
#
# Provisions a Linux host for the Shortwave bot.
#
# Primary target:
#   - Ubuntu Server 24.04 LTS (amd64), e.g. a Hyper-V VM
#
# Also supported:
#   - Debian 13 (amd64)
#   - Raspberry Pi OS 64-bit (arm64)
#   - Raspberry Pi OS 32-bit (armhf) — Node comes from the nodejs.org tarball
#
# It detects the architecture, picks the right Node install route, and applies
# the swap and memory tweaks only on hosts that need them.
#
# Run as a user with sudo:
#     chmod +x setup-host.sh && sudo ./setup-host.sh
#
# It is idempotent — safe to re-run.

set -euo pipefail

BOT_USER="lovensebot"
APP_DIR="/opt/lovense-bot"
NODE_MAJOR="22"
SWAP_MB="1024"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

# Total RAM in MB — decides whether swap tuning is worth doing and which
# systemd unit to recommend at the end.
TOTAL_RAM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"

# Threshold for "this host has room". Deliberately 1800 rather than 2048:
# MemTotal excludes memory the kernel and firmware reserve, so a VM assigned
# 2 GB reports roughly 1900-2000 MB. A 1 GB Pi reports around 950. 1800
# separates the two cleanly without tripping over the reservation.
ROOMY_RAM_MB=1800

# ---------------------------------------------------------------------------
log "System packages"
# ---------------------------------------------------------------------------
apt-get update
apt-get upgrade -y
# build-essential and python3 are only needed if better-sqlite3 has no prebuilt
# binary for this architecture and has to compile from source. That is the case
# on 32-bit ARM; on amd64 and arm64 they go unused but cost little.
apt-get install -y curl ca-certificates gnupg git build-essential python3 sqlite3

# ---------------------------------------------------------------------------
log "Swap"
# ---------------------------------------------------------------------------
# Only relevant on small-memory hosts that use dphys-swapfile (Raspberry Pi OS).
# A Pi 3 B has 1 GB of RAM and its stock 100 MB swap is not enough for
# `npm ci`, which gets OOM-killed without this. A 2 GB VM needs none of it.
if [[ ! -f /etc/dphys-swapfile ]]; then
  echo "No dphys-swapfile on this host; skipping (normal on a VM or plain Debian/Ubuntu)."
elif [[ "$TOTAL_RAM_MB" -ge "$ROOMY_RAM_MB" ]]; then
  echo "${TOTAL_RAM_MB} MB of RAM; swap tuning not needed."
else
  current=$(grep -E '^CONF_SWAPSIZE=' /etc/dphys-swapfile | cut -d= -f2 || echo 0)
  if [[ "$current" != "$SWAP_MB" ]]; then
    sed -i "s/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=${SWAP_MB}/" /etc/dphys-swapfile
    # The default cap is 2048 MB; raise it only if we need to.
    sed -i "s/^#\?CONF_MAXSWAP=.*/CONF_MAXSWAP=${SWAP_MB}/" /etc/dphys-swapfile
    dphys-swapfile swapoff || true
    dphys-swapfile setup
    dphys-swapfile swapon
    echo "Swap set to ${SWAP_MB} MB."
  else
    echo "Swap already ${SWAP_MB} MB."
  fi
fi

# ---------------------------------------------------------------------------
log "Node.js ${NODE_MAJOR}.x"
# ---------------------------------------------------------------------------
# Use the DPKG architecture, not `uname -m`. Recent Raspberry Pi OS 32-bit
# images ship a 64-bit kernel with a 32-bit userland, so `uname -m` reports
# aarch64 while every binary you can actually run is armhf.
DPKG_ARCH="$(dpkg --print-architecture)"
echo "Detected userland architecture: ${DPKG_ARCH}"

install_node_from_tarball() {
  # $1 = nodejs.org arch suffix (e.g. armv7l)
  local suffix="$1"
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  local file

  apt-get install -y xz-utils
  file="$(curl -fsSL "${base}/" \
          | grep -o "node-v[0-9.]*-linux-${suffix}\.tar\.xz" | head -1)"

  if [[ -z "$file" ]]; then
    echo "Could not find a linux-${suffix} build for Node ${NODE_MAJOR}.x." >&2
    echo "Node 24 dropped 32-bit ARM; if NODE_MAJOR is above 22 that is why." >&2
    exit 1
  fi

  echo "Installing ${file}"
  curl -fsSLo "/tmp/${file}" "${base}/${file}"
  rm -rf /usr/local/lib/nodejs
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "/tmp/${file}" -C /usr/local/lib/nodejs --strip-components=1
  rm -f "/tmp/${file}"

  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/bin/npm  /usr/local/bin/npm
  ln -sf /usr/local/lib/nodejs/bin/npx  /usr/local/bin/npx
}

need_node=true
if command -v node >/dev/null 2>&1; then
  current_major="$(node -v | cut -c2- | cut -d. -f1)"
  if [[ "$current_major" -ge "$NODE_MAJOR" ]]; then
    need_node=false
    echo "Node $(node -v) already installed."
  fi
fi

if [[ "$need_node" == true ]]; then
  case "$DPKG_ARCH" in
    amd64|arm64)
      # NodeSource publishes apt packages for these.
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
      apt-get install -y nodejs
      ;;
    armhf)
      cat <<'WARN'

  ---------------------------------------------------------------------
  This is a 32-bit (armhf) OS. NodeSource does not publish armhf
  packages, so Node will be installed from the official nodejs.org
  ARMv7 tarball instead.

  This works, but be aware: Node 22 is the LAST release line with
  official 32-bit ARM builds. Node 24 dropped them. A 64-bit host
  (an amd64 VM, or Raspberry Pi OS 64-bit) avoids this dead end.
  ---------------------------------------------------------------------

WARN
      install_node_from_tarball armv7l
      ;;
    armel)
      echo "ARMv6/armel is not supported by modern Node. Use a 64-bit host." >&2
      exit 1
      ;;
    *)
      echo "Unrecognised architecture: ${DPKG_ARCH}" >&2
      exit 1
      ;;
  esac
fi

# The systemd unit references /usr/local/bin/node, so it does not care which of
# the install paths above ran.
if [[ ! -e /usr/local/bin/node ]]; then
  ln -sf "$(command -v node)" /usr/local/bin/node
fi

echo "node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------------------
log "Service account: ${BOT_USER}"
# ---------------------------------------------------------------------------
# A system user with no login shell and no password. Nothing about this bot
# needs an interactive session.
if ! id -u "$BOT_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${BOT_USER}" \
          --shell /usr/sbin/nologin "$BOT_USER"
  echo "Created ${BOT_USER}."
else
  echo "${BOT_USER} already exists."
fi

# ---------------------------------------------------------------------------
log "Application directory: ${APP_DIR}"
# ---------------------------------------------------------------------------
mkdir -p "${APP_DIR}" "${APP_DIR}/data"
chown -R "${BOT_USER}:${BOT_USER}" "${APP_DIR}"
chmod 750 "${APP_DIR}"
chmod 700 "${APP_DIR}/data"

# ---------------------------------------------------------------------------
log "Unattended security updates"
# ---------------------------------------------------------------------------
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# Security patches: yes. Rebooting the host out from under a running session:
# no. Ubuntu in particular ships configurations that reboot automatically once
# a patch asks for it, which would end a session with no warning. Patches that
# need a reboot simply wait until you reboot deliberately.
cat > /etc/apt/apt.conf.d/99-shortwave-no-auto-reboot <<'CONF'
// Managed by Shortwave's setup script.
// Never reboot automatically - a session may be in progress.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
CONF
echo "Automatic reboots disabled (/etc/apt/apt.conf.d/99-shortwave-no-auto-reboot)."
echo "Check for pending reboots yourself with: ls /var/run/reboot-required"

# ---------------------------------------------------------------------------
# Which systemd unit fits this host
# ---------------------------------------------------------------------------
if [[ "$TOTAL_RAM_MB" -ge "$ROOMY_RAM_MB" ]]; then
  UNIT="lovense-bot.service"
  UNIT_NOTE="${TOTAL_RAM_MB} MB of RAM — the standard unit (1 GB cap) fits."
else
  UNIT="lovense-bot.pi.service"
  UNIT_NOTE="${TOTAL_RAM_MB} MB of RAM — use the low-memory unit (400 MB cap)."
fi

cat <<EOF

Done.

Host: ${DPKG_ARCH}, ${TOTAL_RAM_MB} MB RAM
${UNIT_NOTE}

Next:
  1. Put the bot source in ${APP_DIR} (git clone or rsync), then:
       sudo chown -R ${BOT_USER}:${BOT_USER} ${APP_DIR}
  2. Create ${APP_DIR}/.env from .env.example and fill it in:
       sudo -u ${BOT_USER} cp ${APP_DIR}/.env.example ${APP_DIR}/.env
       sudo chmod 600 ${APP_DIR}/.env
  3. Build:
       cd ${APP_DIR}
       sudo -u ${BOT_USER} npm install    # 'npm ci' once package-lock.json exists
       sudo -u ${BOT_USER} npm run build
       sudo -u ${BOT_USER} npm run deploy-commands
  4. Install the service:
       sudo cp ${APP_DIR}/deploy/${UNIT} /etc/systemd/system/lovense-bot.service
       sudo systemctl daemon-reload
       sudo systemctl enable --now lovense-bot

See DEPLOY.md for the Cloudflare Tunnel setup that makes the callback URL
reachable from the internet.
EOF
