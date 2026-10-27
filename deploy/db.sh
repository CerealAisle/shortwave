#!/usr/bin/env bash
#
# Canned queries against the bot's database. Read-only.
#
#     sudo /opt/lovense-bot/deploy/db.sh                    # commands, last 24 hours
#     sudo /opt/lovense-bot/deploy/db.sh commands 6         # last 6 hours
#     sudo /opt/lovense-bot/deploy/db.sh commands 24 --failed
#     sudo /opt/lovense-bot/deploy/db.sh commands 24 --source probe
#     sudo /opt/lovense-bot/deploy/db.sh summary 48         # per hour: ok / failed / 507s
#     sudo /opt/lovense-bot/deploy/db.sh nights             # first and last success per night
#     sudo /opt/lovense-bot/deploy/db.sh links              # linked apps and last check-in
#     sudo /opt/lovense-bot-staging/deploy/db.sh ...        # staging
#
# The instance is the one this script lives in, as with update.sh. Its
# database is DATABASE_PATH from that instance's .env (default data/bot.db).
#
# Sources in the command log:
#   probe          the prober (only while tease is on)
#   message:<id>   a tease buzz from a Discord message (":retryN" = wake retry)
#   test:<user>    /test          tease-check:<user>  /tease checking first
#   buzz / pattern / disarm / suspend / stop-all / shutdown / tease-off
#
# Output goes through less when it's a terminal; pipe it to keep it plain.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOT_USER="${BOT_USER:-lovensebot}"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
command -v sqlite3 >/dev/null || die "sqlite3 isn't installed (sudo apt install sqlite3)."

# DATABASE_PATH from .env, relative to the instance directory.
DB_REL="$(sed -n 's/^DATABASE_PATH=//p' "$APP_DIR/.env" 2>/dev/null | tail -1 | tr -d '"'"'" || true)"
DB_REL="${DB_REL:-./data/bot.db}"
if [[ "$DB_REL" == /* ]]; then DB="$DB_REL"; else DB="$APP_DIR/${DB_REL#./}"; fi

run_sql() {
  # Read-only, as the bot's user, so file ownership never changes.
  local cmd=(sqlite3 -readonly -header -column "$DB" "$1")
  if [[ "$(id -un)" == "$BOT_USER" ]]; then "${cmd[@]}"; else sudo -u "$BOT_USER" "${cmd[@]}"; fi
}

page() { if [[ -t 1 ]]; then less -RS +G; else cat; fi; }

int_or() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo "$2"; }

WHAT="${1:-commands}"
[[ $# -gt 0 ]] && shift

case "$WHAT" in
  commands)
    HOURS="$(int_or "${1:-}" 24)"
    [[ "${1:-}" =~ ^[0-9]+$ ]] && shift
    WHERE="created_at > (strftime('%s','now') - $HOURS * 3600) * 1000"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --failed) WHERE+=" AND ok = 0"; shift ;;
        --source)
          [[ "${2:-}" =~ ^[A-Za-z0-9:_-]+$ ]] || die "--source takes a prefix like probe, message, test"
          WHERE+=" AND source LIKE '$2%'"; shift 2 ;;
        *) die "Unknown option for commands: $1" ;;
      esac
    done
    run_sql "
      SELECT datetime(created_at/1000,'unixepoch','localtime') AS time,
             source,
             CASE ok WHEN 1 THEN 'ok' ELSE 'FAILED' END AS result,
             description,
             coalesce(error, '') AS error
        FROM command_log
       WHERE $WHERE
       ORDER BY id;" | page
    ;;

  summary)
    HOURS="$(int_or "${1:-}" 24)"
    run_sql "
      SELECT strftime('%Y-%m-%d %H:00', created_at/1000, 'unixepoch', 'localtime') AS hour,
             count(*)                                         AS sent,
             sum(ok)                                          AS ok,
             sum(1 - ok)                                      AS failed,
             sum(CASE WHEN error LIKE '%offline%' THEN 1 ELSE 0 END) AS app_offline_507,
             sum(CASE WHEN source LIKE 'probe%' THEN 1 ELSE 0 END)   AS probes,
             sum(CASE WHEN source LIKE 'message:%' THEN 1 ELSE 0 END) AS tease
        FROM command_log
       WHERE created_at > (strftime('%s','now') - $HOURS * 3600) * 1000
       GROUP BY hour
       ORDER BY hour;" | page
    ;;

  nights)
    # A night runs noon to noon, so one that crosses midnight stays one row.
    run_sql "
      SELECT date(created_at/1000 - 43200, 'unixepoch', 'localtime') AS night_of,
             min(CASE WHEN ok = 1 THEN datetime(created_at/1000,'unixepoch','localtime') END) AS first_ok,
             max(CASE WHEN ok = 1 THEN datetime(created_at/1000,'unixepoch','localtime') END) AS last_ok,
             min(CASE WHEN error LIKE '%offline%' THEN datetime(created_at/1000,'unixepoch','localtime') END) AS first_507,
             sum(ok) AS ok,
             sum(1 - ok) AS failed
        FROM command_log
       GROUP BY night_of
       ORDER BY night_of DESC
       LIMIT 14;" | page
    ;;

  links)
    run_sql "
      SELECT display_name,
             discord_user_id,
             guild_id,
             platform,
             datetime(last_seen/1000,'unixepoch','localtime') AS last_check_in,
             (strftime('%s','now') - last_seen/1000) / 60      AS minutes_ago,
             callback_count AS check_ins,
             datetime(created_at/1000,'unixepoch','localtime') AS linked
        FROM toy_links
       ORDER BY last_seen DESC;"
    ;;

  -h|--help|help)
    sed -n '2,26p' "$0"
    ;;

  *)
    die "Unknown query: $WHAT (commands, summary, nights, links, or --help)"
    ;;
esac
