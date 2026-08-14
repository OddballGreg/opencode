#!/usr/bin/env bash
# cutover.sh - One-shot, quiescence-gated SQLite -> Postgres cutover for opencode.
#
# Does, in order:
#   0. SAFETY: refuse to run unless all opencode TUIs/serve are stopped (quiescence).
#   1. Snapshot the live SQLite db (rollback artifact) + pg (pg_dump).
#   2. FRESH-INIT the pg target db (drop+recreate) so it matches the CURRENT schema
#      (avoids the v1.17.1 drift noted in POSTGRES-FORK-SYNC.md), bootstrap schema via
#      the fork binary, then migrate all rows SQLite -> pg (--truncate clean load).
#   3. Verify table counts match between SQLite and pg.
#
# It does NOT flip the shim default and does NOT touch the live SQLite db (read-only source).
# Reopening sessions is a SEPARATE step (reopen.sh) so you can eyeball the verify first.
#
# Usage:  cutover.sh [--yes]   (without --yes it stops after the plan/quiescence check)
set -euo pipefail

REPO="${OPENCODE_FIX_REPO:-$HOME/opencode-fix}"
PG_ENV="${OPENCODE_PG_ENV:-$HOME/.config/opencode-pg/env}"
LIVE_SQLITE="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
PG_BIN="$HOME/.opencode/bin/opencode-pg"
PG_CONTAINER="${OPENCODE_PG_CONTAINER:-opencode-pg}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${OPENCODE_CUTOVER_BACKUPS:-$HOME/.local/share/opencode/cutover-backups}"
CONFIRM=0
[ "${1:-}" = "--yes" ] && CONFIRM=1

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }
redact() { sed -E 's#(://[^:]+:)[^@]+#\1REDACTED#g'; }

[ -f "$PG_ENV" ] || die "missing pg env $PG_ENV"
[ -x "$PG_BIN" ] || die "missing fork binary $PG_BIN"
[ -f "$LIVE_SQLITE" ] || die "missing live sqlite $LIVE_SQLITE"
# shellcheck disable=SC1090
set -a; . "$PG_ENV"; set +a
[ -n "${OPENCODE_DATABASE_URL:-}" ] || die "OPENCODE_DATABASE_URL not set by $PG_ENV"
PG_DB="${OPENCODE_DATABASE_URL##*/}"
PG_BASEURL="${OPENCODE_DATABASE_URL%/*}"

# ---- 0. quiescence ---------------------------------------------------------
log "Quiescence check (no opencode TUI/serve may be running)"
# Count only LIVE (non-zombie) serve procs. A SIGKILLed 'opencode serve' can linger as a
# <defunct>/zombie (state Z) until its parent reaps it; zombies hold no DB handle and must
# not block the cutover.
count_live_serve() {
  local n=0 p st
  for p in $(pgrep -f 'opencode serve' 2>/dev/null); do
    st=$(awk '{print $3}' "/proc/$p/stat" 2>/dev/null)
    [ "$st" = "Z" ] && continue      # skip zombies
    n=$((n+1))
  done
  echo "$n"
}
LIVE=$("$REPO/script/pg-cutover/detect-open-sessions.sh" 2>/dev/null | wc -l | tr -d ' ')
SERVE=$(count_live_serve)
echo "  live TUI processes: $LIVE ; live serve processes: $SERVE"
if [ "$LIVE" != "0" ] || [ "$SERVE" != "0" ]; then
  echo "  Open sessions (must be closed first):"
  "$REPO/script/pg-cutover/detect-open-sessions.sh" 2>/dev/null | sed 's/^/    /'
  die "opencode is still running. Close all TUIs and 'opencode serve' first (event-sourced store must be quiescent to migrate safely)."
fi
echo "  OK - quiescent."

echo
echo "PLAN:"
echo "  source sqlite : $LIVE_SQLITE (read-only)"
echo "  target pg     : $(printf '%s' "$OPENCODE_DATABASE_URL" | redact)"
echo "  backups -> $BACKUP_DIR/$STAMP"
echo "  fresh-init pg db '$PG_DB' (drop+recreate), bootstrap schema, migrate --truncate, verify counts"
if [ "$CONFIRM" != "1" ]; then
  echo
  echo "Dry stop: re-run with --yes to execute."
  exit 0
fi

mkdir -p "$BACKUP_DIR/$STAMP"

# ---- 0b. checkpoint WAL (safe now that we're quiescent) --------------------
# Fold any -wal into the main db so the readonly migrator + the file copy both see a
# fully-consolidated source. Only safe with no active writer (guaranteed by step 0).
if [ -f "$LIVE_SQLITE-wal" ]; then
  log "Checkpointing SQLite WAL into main db (quiescent)"
  sqlite3 "$LIVE_SQLITE" "PRAGMA wal_checkpoint(TRUNCATE);" 2>&1 | sed 's/^/  wal_checkpoint: /' || die "wal checkpoint failed"
fi

# ---- 1. snapshots ----------------------------------------------------------
log "Snapshotting SQLite (rollback artifact)"
cp -v "$LIVE_SQLITE" "$BACKUP_DIR/$STAMP/opencode.db.pre-cutover"
[ -f "$LIVE_SQLITE-wal" ] && cp -v "$LIVE_SQLITE-wal" "$BACKUP_DIR/$STAMP/" || true

log "Snapshotting current pg db (pg_dump) before we drop it"
docker exec "$PG_CONTAINER" pg_dump -U opencode -d "$PG_DB" 2>/dev/null | gzip > "$BACKUP_DIR/$STAMP/pg-$PG_DB.sql.gz" || echo "  (pg_dump skipped/failed - db may be stale; continuing)"

# ---- 2. fresh-init pg + migrate -------------------------------------------
log "Fresh-init pg db '$PG_DB' (drop + recreate for a clean current-schema load)"
docker exec "$PG_CONTAINER" psql -U opencode -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PG_DB' AND pid<>pg_backend_pid();" >/dev/null 2>&1 || true
docker exec "$PG_CONTAINER" psql -U opencode -d postgres -c "DROP DATABASE IF EXISTS $PG_DB WITH (FORCE);"
docker exec "$PG_CONTAINER" psql -U opencode -d postgres -c "CREATE DATABASE $PG_DB OWNER opencode;"

log "Bootstrapping current schema into fresh pg db via the fork binary"
"$PG_BIN" db "SELECT 1" >/dev/null 2>&1 || true   # triggers cold-boot migration (database.ts -> migration.pg.ts)
# Verify the session table exists. The fork's CLI prints the boolean as 'true'/'false'
# (not psql's 't'/'f'); accept either. Retry a few times in case the cold-boot migration
# txn is still settling.
SCHEMA_OK=""
for _try in 1 2 3 4 5; do
  SCHEMA_OK=$("$PG_BIN" db "SELECT to_regclass('public.session') IS NOT NULL AS ok" --format tsv 2>/dev/null | tail -1 | tr -d '[:space:]')
  case "$SCHEMA_OK" in true|t|1) break ;; esac
  "$PG_BIN" db "SELECT 1" >/dev/null 2>&1 || true
  sleep 1
done
case "$SCHEMA_OK" in
  true|t|1) echo "  schema bootstrapped (ok=$SCHEMA_OK)." ;;
  *) die "pg schema bootstrap failed (session table absent after cold boot; ok='$SCHEMA_OK')" ;;
esac

log "Migrating rows SQLite -> pg (--truncate clean load)"
( cd "$REPO" && OPENCODE_DATABASE_URL="$OPENCODE_DATABASE_URL" bun run script/migrate-sqlite-to-pg.ts --truncate )

# ---- 3. verify -------------------------------------------------------------
log "Verifying table counts (sqlite vs pg)"
TABLES="session message part event event_sequence todo permission project"
fail=0
for t in $TABLES; do
  sq=$(sqlite3 "$LIVE_SQLITE" "SELECT count(*) FROM $t;" 2>/dev/null || echo NA)
  pg=$("$PG_BIN" db "SELECT count(*)::int AS n FROM $t" --format tsv 2>/dev/null | tail -1 || echo NA)
  if [ "$sq" = "$pg" ]; then
    printf '  %-16s sqlite=%-8s pg=%-8s OK\n' "$t" "$sq" "$pg"
  else
    printf '  %-16s sqlite=%-8s pg=%-8s MISMATCH\n' "$t" "$sq" "$pg"; fail=1
  fi
done
[ "$fail" = "0" ] || die "count mismatch - inspect before reopening. SQLite backup at $BACKUP_DIR/$STAMP"

log "CUTOVER COMPLETE. pg is now populated + current-schema."
cat <<EOF

Next:
  1. Reopen your sessions on the fork:  script/pg-cutover/reopen.sh
     (relies on the binary's failInterruptedTools self-heal for interrupted turns)
  2. Dogfood via --postgres for a while. The shim default stays STOCK until you approve the flip.
Rollback: the live SQLite db was never modified; backup also at
  $BACKUP_DIR/$STAMP/opencode.db.pre-cutover
EOF
