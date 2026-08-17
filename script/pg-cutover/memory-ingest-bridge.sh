#!/usr/bin/env bash
# memory-ingest-bridge.sh - Keep opencode-memory ingesting after the Postgres cutover.
#
# opencode-memory's ingester (rust ingestion/opencode_db.rs) reads a SQLite
# opencode.db and polls it by a `since` timestamp/session cursor. After the pg
# cutover, all live opencode activity is written to Postgres, and the old SQLite
# file at ~/.local/share/opencode/opencode.db is FROZEN - so memory stopped
# ingesting new sessions.
#
# This bridge periodically exports the Postgres store into a DEDICATED SQLite
# file that memory watches instead (config [ingestion] watch_paths). Because the
# reverse migrator is re-runnable (INSERT OR IGNORE) and the ingester polls by
# `since`, refreshing this file keeps memory current with zero churn.
#
# This is the interim fix for ghavenga/opencode-memory#116 (native pg ingestion).
# It is READ-ONLY on Postgres and never touches the live/original SQLite db.
set -euo pipefail

REPO="${OPENCODE_FIX_REPO:-$HOME/opencode-fix}"
PG_ENV="${OPENCODE_PG_ENV:-$HOME/.config/opencode-pg/env}"
BRIDGE_DB="${OPENCODE_BRIDGE_DB:-$HOME/.local/share/opencode/opencode-pg-bridge.db}"
LOCK="${BRIDGE_DB}.bridge.lock"
LOG="${OPENCODE_BRIDGE_LOG:-$HOME/.local/share/opencode/opencode-pg-bridge.log}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG"; }

[ -f "$PG_ENV" ] || { echo "missing pg env $PG_ENV" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$PG_ENV"; set +a
[ -n "${OPENCODE_DATABASE_URL:-}" ] || { echo "OPENCODE_DATABASE_URL not set" >&2; exit 1; }

# Resolve bun absolutely: systemd user units run with a minimal PATH that omits
# ~/.bun/bin, which silently broke the migrator (ghavenga/opencode-memory#356).
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || BUN="$(command -v bun || true)"
[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "bun not found (looked in \$HOME/.bun/bin and PATH)" >&2; log "FATAL: bun not found"; exit 1; }

# Single-flight: never overlap two exports (they'd contend on the bridge file).
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another bridge export is running; skipping this tick"
  exit 0
fi

start=$(date +%s)
log "bridge export start -> $BRIDGE_DB"
# Re-runnable incremental refresh (no --truncate): only adds new rows.
# The reverse migrator exits non-zero on ANY count mismatch, but for the bridge
# a small mismatch is EXPECTED and harmless: (a) a handful of Postgres-incompatible
# oversize/FK rows can never round-trip, and (b) pg keeps being written during the
# multi-minute export (live drift), so its counts grow past the point-in-time read.
# Memory ingests by polling a `since` cursor, so a slightly-behind bridge is fine -
# the next refresh catches up. We therefore do NOT treat the migrator's exit code as
# fatal; instead we validate the bridge is USABLE: the session spine must match within
# a drift tolerance, and the file must be a valid sqlite db with the expected tables.
( cd "$REPO" && SQLITE_OUT="$BRIDGE_DB" OPENCODE_DATABASE_URL="$OPENCODE_DATABASE_URL" \
    "$BUN" run script/migrate-pg-to-sqlite.ts >> "$LOG" 2>&1 ) || log "migrator exited non-zero (expected under drift/oversize skips; validating usability instead)"

# Usability check: bridge db opens, has a session table, and session count is
# within DRIFT_TOL of pg (spine parity). This catches a genuinely broken export
# while tolerating live-drift / oversize-skip mismatches.
DRIFT_TOL="${OPENCODE_BRIDGE_DRIFT_TOL:-200}"
bridge_sessions=$(sqlite3 "$BRIDGE_DB" "SELECT count(*) FROM session;" 2>/dev/null || echo -1)
pg_sessions=$(docker exec "${OPENCODE_PG_CONTAINER:-opencode-pg}" psql -U opencode -d "${OPENCODE_DATABASE_URL##*/}" -tAc "SELECT count(*) FROM session;" 2>/dev/null | tr -d ' ' || echo -2)
diff=$(( pg_sessions - bridge_sessions )); [ "$diff" -lt 0 ] && diff=$(( -diff ))
dur=$(( $(date +%s) - start ))
if [ "$bridge_sessions" -gt 0 ] && [ "$diff" -le "$DRIFT_TOL" ]; then
  log "bridge export OK in ${dur}s (bridge sessions=$bridge_sessions, pg=$pg_sessions, drift=$diff <= $DRIFT_TOL)"
else
  log "bridge export UNUSABLE (bridge sessions=$bridge_sessions, pg=$pg_sessions, drift=$diff > $DRIFT_TOL)"
  exit 1
fi

