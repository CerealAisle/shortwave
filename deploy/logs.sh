#!/usr/bin/env bash
#
# Read the bot's journal, filtered to connection and presence lines.
#
#     sudo /opt/lovense-bot/deploy/logs.sh                         # last 12 hours
#     sudo /opt/lovense-bot/deploy/logs.sh "2026-10-15 21:00"      # since a time
#     sudo /opt/lovense-bot/deploy/logs.sh "yesterday 22:00" --all # every line
#     sudo /opt/lovense-bot/deploy/logs.sh --follow                # live
#     sudo /opt/lovense-bot-staging/deploy/logs.sh                 # staging
#
# The instance is the one this script lives in, as with update.sh.
#
# The time is anything journalctl --since accepts: "2026-10-15 21:00:00",
# "yesterday", "3 hours ago", "today".
#
# Flags:
#   --all       every line, not just the connection/presence ones
#   --follow    keep watching for new lines (Ctrl-C to stop)
#   --until T   stop at time T
#   --grep RE   your own filter instead of the default one
#
# Heartbeat lines ("(heartbeat)") are only logged at LOG_LEVEL=debug. At the
# default level you see check-ins stopping and resuming, not each one.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="$(basename "$APP_DIR")"

SINCE="12 hours ago"
UNTIL=""
FOLLOW=false
FILTER='heartbeat|Presence|unreachable|Callback|Check-ins|Socket|Lovense command failed|Lovense reported|Session|Tease|Grace|lockout|stopAll|Probe|Prober|Buzz failed|Fatal|Unhandled'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)      FILTER=''; shift ;;
    --follow|-f) FOLLOW=true; shift ;;
    --until)    UNTIL="$2"; shift 2 ;;
    --grep)     FILTER="$2"; shift 2 ;;
    -h|--help)  sed -n '2,24p' "$0"; exit 0 ;;
    -*)         echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    *)          SINCE="$1"; shift ;;
  esac
done

args=(-u "$SERVICE" --no-pager -o short-iso)
if [[ "$FOLLOW" == true ]]; then
  args+=(-f -n 50)
else
  args+=(--since "$SINCE")
  [[ -n "$UNTIL" ]] && args+=(--until "$UNTIL")
fi

filter() {
  if [[ -n "$FILTER" ]]; then grep --line-buffered -E "$FILTER" || true; else cat; fi
}

if [[ "$FOLLOW" == true || ! -t 1 ]]; then
  journalctl "${args[@]}" | filter
else
  journalctl "${args[@]}" | filter | less -R +G
fi
