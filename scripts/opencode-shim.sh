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
#   OPENCODE_PG_BIN=opencode-pg.next opencode ... -> run a specific fork build
#       (name beside this shim, or absolute path). Put it in
#       ~/.config/opencode-pg/env to switch every launch, including bg workers;
#       delete the line to roll back. A missing target falls back to opencode-pg.
#   OPENCODE_SHARED=1 opencode [-s ID|-c] [dir] -> attach to the shared server
#       (opencode-shared.service, OPENCODE_SHARED_URL, default
#       http://127.0.0.1:4096) instead of a private backend; see below.
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
  if [ -f "$PG_ENV" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$PG_ENV"
    set +a
  else
    echo "opencode(shim): warning: $PG_ENV not found; pg binary will fall back to its channel SQLite db." >&2
  fi
  # Build selector: OPENCODE_PG_BIN picks which fork build runs, so a new build
  # can be trialled (or rolled back) by one line in $PG_ENV, with no binary
  # renames. A bare name resolves beside this shim; an absolute path is used
  # as-is. Unset means the default opencode-pg.
  case "${OPENCODE_PG_BIN:-}" in
    "") TARGET="$PG" ;;
    /*) TARGET="$OPENCODE_PG_BIN" ;;
    *) TARGET="$BIN_DIR/$OPENCODE_PG_BIN" ;;
  esac
  if [ ! -x "$TARGET" ]; then
    if [ "$TARGET" != "$PG" ] && [ -x "$PG" ]; then
      echo "opencode(shim): warning: OPENCODE_PG_BIN=$OPENCODE_PG_BIN is missing/not executable; falling back to $PG." >&2
      TARGET="$PG"
    else
      echo "opencode(shim): pg backend requested but $TARGET is missing/not executable." >&2
      exit 127
    fi
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

# Herdr integration. Herdr detects agents by process name, and the real binary
# is opencode-pg/opencode-stock, so tell it explicitly. Non-TUI subcommands
# (run/serve/web) launched from inside a herdr pane must NOT inherit the pane
# identity, or their herdr plugin reports would overwrite the pane's state.
if [ "${HERDR_ENV:-}" = "1" ]; then
  sub=""
  for a in "$@"; do
    case "$a" in
      -*) continue ;;
      *) sub="$a"; break ;;
    esac
  done
  case "$sub" in
    run|serve|web)
      unset HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_SOCKET_PATH HERDR_AGENT
      ;;
    *)
      export HERDR_AGENT=opencode
      # Boot/restore storm gate: when herdr restores every pane at once (after
      # boot, resume, or a herdr server restart), wait for a health-gated turn
      # so the panes start a few at a time (2026-10-22: 47 panes in one minute,
      # load1 307). Returns at once outside a storm or on a calm box. Enter or
      # Ctrl-C in the pane skips the wait (the INT trap keeps this shell alive
      # so opencode still starts). A broken gate admits. Only TUI launches are
      # gated, never --version/--help or one-shot subcommands.
      settle="$HOME/.local/bin/boot-settle"
      gate=1
      case "$sub" in
        mcp|auth|models|stats|export|import|upgrade|uninstall|agent|github|pr|debug|acp|completion|generate) gate=0 ;;
      esac
      for a in "$@"; do
        case "$a" in --version|-v|--help|-h) gate=0 ;; esac
      done
      if [ "$gate" = "1" ] && [ -x "$settle" ] && [ "${OPENCODE_NO_SETTLE:-}" != "1" ]; then
        trap : INT
        "$settle" acquire --class tui --only-if-storm --name "herdr-pane-${HERDR_PANE_ID:-?}" || true
        trap - INT
      fi
      ;;
  esac
fi

# Shared server (opt-in: OPENCODE_SHARED=1, e.g. in $PG_ENV). A plain TUI launch
# attaches to one long-lived `opencode serve` (opencode-shared.service on
# $OPENCODE_SHARED_URL) instead of starting a full backend per pane: ~184 MB per
# attached client instead of ~924 MB, and MCP servers are started once per
# directory on the server rather than once per pane (measured 2026-10-15).
# Only translated when EVERY argument is one `attach` understands; any other
# flag (--model, --prompt, --agent, --auto, server flags) or subcommand runs
# standalone exactly as before. If the server is not healthy, start standalone.
if [ "$backend" = "postgres" ] && [ "${OPENCODE_SHARED:-}" = "1" ]; then
  shared_url="${OPENCODE_SHARED_URL:-http://127.0.0.1:4096}"
  shared_ok=1
  shared_dir=""
  expect_value=""
  for a in "$@"; do
    if [ -n "$expect_value" ]; then expect_value=""; continue; fi
    case "$a" in
      --print-logs|--pure|-c|--continue|--fork|--mini|--no-replay) ;;
      --log-level|-s|--session|--replay-limit) expect_value=1 ;;
      --log-level=*|--session=*|--replay-limit=*) ;;
      -*) shared_ok=0; break ;;
      *)
        if [ -z "$shared_dir" ] && [ -d "$a" ]; then shared_dir="$a"; else shared_ok=0; break; fi
        ;;
    esac
  done
  [ -n "$expect_value" ] && shared_ok=0
  if [ "$shared_ok" = "1" ]; then
    if curl -sf -m 2 "$shared_url/global/health" >/dev/null 2>&1; then
      if [ -n "$shared_dir" ]; then
        # Drop the positional project dir; it becomes --dir.
        n=$#
        removed=0
        while [ "$n" -gt 0 ]; do
          a="$1"; shift; n=$((n - 1))
          if [ "$removed" = "0" ] && [ "$a" = "$shared_dir" ]; then removed=1; else set -- "$@" "$a"; fi
        done
        shared_dir="$(cd "$shared_dir" && pwd)"
      else
        shared_dir="$PWD"
      fi
      exec "$TARGET" attach "$shared_url" --dir "$shared_dir" "$@"
    fi
    echo "opencode(shim): shared server $shared_url is not healthy; starting standalone." >&2
  fi
fi

exec "$TARGET" "$@"