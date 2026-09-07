#!/bin/sh
# opencode launch shim (two-way door: stock SQLite by default, Postgres fork opt-in)
#
# WHY THIS EXISTS:
#   The real binaries live beside this shim:
#     opencode-stock  - upstream/stock build (SQLite only). Auto-updates in place.
#     opencode-pg     - Postgres-backend fork build.
#   This shim owns the `opencode` name on PATH and dispatches to one of them.
#
#   opencode's self-upgrade overwrites process.execPath. Because this shim EXECs
#   the real binary, process.execPath inside the child is opencode-stock (or
#   opencode-pg), never this shim. So a stray auto-update can only ever replace
#   opencode-stock - it can NOT clobber the fork or this shim. (An auto-update on
#   2026-08-05 clobbered the fork binary back to stock; this design prevents that.)
#
# USAGE:
#   opencode [args...]              -> Postgres fork (DEFAULT; sources ~/.config/opencode-pg/env)
#   opencode --sqlite  [args...]    -> stock/SQLite escape hatch
#   opencode --postgres [args...]   -> force pg explicitly (same as default)
#   opencode --which                -> print which backend/binary would run, then exit
#   OPENCODE_BACKEND=stock opencode ...      -> env override to force SQLite
#
# Default flipped stock->postgres 2026-08-14 after the cutover + fixes proved
# stable (event-write FOR UPDATE lock landed; 1-month health review reminder set).
# --sqlite remains a one-flag rollback if pg ever misbehaves.
#
# The --postgres/--sqlite/--which sentinels are consumed by the shim and NOT
# passed through. Everything else is forwarded verbatim (stdin/tty/exit code).

BIN_DIR="${0%/*}"
case "$BIN_DIR" in
  "$0") BIN_DIR="." ;;   # invoked without a path component
esac
STOCK="$BIN_DIR/opencode-stock"
PG="$BIN_DIR/opencode-pg"
PG_ENV="${OPENCODE_PG_ENV:-$HOME/.config/opencode-pg/env}"

backend="${OPENCODE_BACKEND:-postgres}"   # default: postgres (flipped from stock 2026-08-14)
show_which=0

# Consume a single leading backend sentinel if present.
case "${1:-}" in
  --postgres|--pg) backend="postgres"; shift ;;
  --sqlite|--stock) backend="stock"; shift ;;
esac
# --which can appear as the (post-sentinel) first arg.
case "${1:-}" in
  --which) show_which=1; shift ;;
esac

# Upgrade self-protection: never let `upgrade` run through the pg fork, and make
# clear it only ever touches the stock binary.
for a in "$@"; do
  case "$a" in
    upgrade)
      if [ "$backend" = "postgres" ]; then
        echo "opencode(shim): 'upgrade' forced onto stock binary (fork is managed by sync-pg-fork.sh)." >&2
        backend="stock"
      fi
      break
      ;;
    -*) continue ;;   # skip flags, keep scanning for the subcommand
    *) break ;;       # first non-flag token is the subcommand; stop
  esac
done

if [ "$backend" = "postgres" ]; then
  TARGET="$PG"
  if [ ! -x "$TARGET" ]; then
    echo "opencode(shim): pg backend requested but $TARGET is missing/not executable." >&2
    exit 127
  fi
  if [ -f "$PG_ENV" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$PG_ENV"
    set +a
  else
    echo "opencode(shim): warning: $PG_ENV not found; pg binary will fall back to its channel SQLite db." >&2
  fi
else
  TARGET="$STOCK"
  # Ensure no stray pg URL leaks into a stock run.
  unset OPENCODE_DATABASE_URL
  if [ ! -x "$TARGET" ]; then
    echo "opencode(shim): stock binary $TARGET is missing/not executable." >&2
    exit 127
  fi
fi

if [ "$show_which" = "1" ]; then
  echo "backend: $backend"
  echo "binary:  $TARGET"
  echo "version: $("$TARGET" --version 2>/dev/null || echo '?')"
  [ "$backend" = "postgres" ] && echo "pg_env:  $PG_ENV"
  exit 0
fi

exec "$TARGET" "$@"