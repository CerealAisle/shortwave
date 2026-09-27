#!/usr/bin/env bash
#
# Pull the latest main and redeploy. Run on the bot host:
#
#     sudo /opt/lovense-bot/deploy/update.sh
#
# Flags:
#   --yes           skip the "this will disarm any active session" prompt
#   --skip-tests    deploy without running the test suite (not recommended)
#   --ref <ref>     deploy a specific branch, tag or commit instead of main
#
# It stops before restarting if the build or the tests fail, so a broken
# commit cannot take the running bot down with it.

set -euo pipefail

APP_DIR="/opt/lovense-bot"
BOT_USER="lovensebot"
SERVICE="lovense-bot"
REF="origin/main"
ASSUME_YES=false
RUN_TESTS=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y)     ASSUME_YES=true; shift ;;
    --skip-tests) RUN_TESTS=false; shift ;;
    --ref)        REF="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this with sudo (it needs systemctl)."
[[ -d "$APP_DIR/.git" ]] || die "$APP_DIR is not a git checkout. See WORKFLOW.md."

cd "$APP_DIR"

# ---------------------------------------------------------------------------
# EVERY git call goes through this. The script runs as root, but the checkout
# is owned by $BOT_USER, and git refuses to operate on a repository owned by
# someone else ("detected dubious ownership"). Running git as the owner avoids
# that without weakening the guard via safe.directory.
# ---------------------------------------------------------------------------
git_bot() { sudo -u "$BOT_USER" git "$@"; }

if ! git_bot rev-parse --git-dir >/dev/null 2>&1; then
  warn "git cannot operate on $APP_DIR as $BOT_USER."
  warn "If the error above mentions 'dubious ownership', parts of the"
  warn "checkout are owned by another user. Fix with:"
  warn "    sudo chown -R $BOT_USER:$BOT_USER $APP_DIR"
  die "Cannot continue."
fi

# ---------------------------------------------------------------------------
# Refuse to throw away uncommitted work on the host.
# ---------------------------------------------------------------------------
if ! git_bot diff --quiet HEAD -- 2>/dev/null; then
  warn "There are uncommitted changes in $APP_DIR:"
  git_bot status --short
  die "Commit, stash or discard them before deploying."
fi

PREVIOUS="$(git_bot rev-parse HEAD)"
PREVIOUS_SHORT="$(git_bot rev-parse --short "$PREVIOUS")"

# ---------------------------------------------------------------------------
# A restart always comes back disarmed, which ends any session in progress.
# ---------------------------------------------------------------------------
if [[ "$ASSUME_YES" != true ]] && systemctl is-active --quiet "$SERVICE"; then
  warn "Restarting will disarm any session currently running."
  read -r -p "Continue? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

log "Fetching"
git_bot fetch --prune origin

TARGET="$(git_bot rev-parse "$REF")" \
  || die "Could not resolve '$REF'. Is it a valid branch, tag or commit?"
TARGET_SHORT="$(git_bot rev-parse --short "$TARGET")"

if [[ "$PREVIOUS" == "$TARGET" ]]; then
  echo "Already at ${TARGET_SHORT} — nothing to deploy."
  exit 0
fi

echo "Deploying ${PREVIOUS_SHORT} -> ${TARGET_SHORT}"
git_bot --no-pager log --oneline "$PREVIOUS..$TARGET" | sed 's/^/    /'

log "Checking out $REF"
# Tracked files are replaced; .env, data/ and node_modules/ are gitignored and
# therefore left untouched.
git_bot checkout --quiet --detach "$TARGET"

log "Installing dependencies"
sudo -u "$BOT_USER" npm ci

log "Building"
sudo -u "$BOT_USER" npm run build

if [[ "$RUN_TESTS" == true ]]; then
  log "Testing"
  if ! sudo -u "$BOT_USER" npm test; then
    warn "Tests failed. The running bot has NOT been restarted."
    warn "Roll the checkout back with:"
    warn "    sudo -u $BOT_USER git -C $APP_DIR checkout --detach $PREVIOUS_SHORT"
    warn "    sudo -u $BOT_USER npm --prefix $APP_DIR run build"
    exit 1
  fi
fi

log "Restarting $SERVICE"
systemctl restart "$SERVICE"

# ---------------------------------------------------------------------------
# Verify it actually came back, rather than assuming.
# ---------------------------------------------------------------------------
PORT="$(grep -E '^CALLBACK_PORT=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || true)"
PORT="${PORT:-4000}"

sleep 3
if ! systemctl is-active --quiet "$SERVICE"; then
  warn "$SERVICE did not come back up. Recent logs:"
  journalctl -u "$SERVICE" -n 30 --no-pager
  die "Deploy failed. Roll back with: sudo $APP_DIR/deploy/update.sh --ref $PREVIOUS_SHORT --yes"
fi

HEALTHY=false
for _ in 1 2 3 4 5; do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  sleep 2
done

if [[ "$HEALTHY" != true ]]; then
  warn "Service is running but /healthz did not answer on port ${PORT}."
  warn "Check: journalctl -u $SERVICE -n 50"
fi

printf '\n\033[1;32mDeployed.\033[0m\n'
cat <<EOF

  from   ${PREVIOUS_SHORT}
  to     ${TARGET_SHORT}
  health $([[ "$HEALTHY" == true ]] && echo "ok" || echo "NOT CONFIRMED")

The bot restarted, so it is DISARMED. Run /on again when ready.

Roll back with:
  sudo $APP_DIR/deploy/update.sh --ref ${PREVIOUS_SHORT} --yes
EOF
