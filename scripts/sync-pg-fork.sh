#!/usr/bin/env bash
#
# sync-pg-fork.sh - Resync the opencode Postgres backend fork onto a new upstream
# release, rebuild the SEPARATE `opencode-pg` binary, and run the verification +
# concurrency soak. Does NOT touch the live daily-driver binary.
#
# See docs/POSTGRES-FORK-SYNC.md for the full narrative.
#
# Usage:
#   scripts/sync-pg-fork.sh [--upstream <ref>] [--no-soak] [--fast]
#
#   --upstream <ref>  Upstream ref to rebase onto (default: origin/dev).
#   --fast            Build without embedding the web UI (quicker; CLI-only test binary).
#   --no-soak         Skip the concurrency soak.
#
# SAFETY (hard rules, mirrored from memory #129961 / #56754):
#   * NEVER overwrites ~/.opencode/bin/opencode (the live binary). Only writes
#     ~/.opencode/bin/opencode-pg.
#   * NEVER runs destructive migrations against the real `opencode` pg database.
#     The soak uses a throwaway db that is dropped afterwards.
#   * NEVER pushes to any remote and NEVER opens MRs.
#   * NEVER prints the Postgres password (URLs are redacted in all output).
#
set -euo pipefail

# ---- config ---------------------------------------------------------------
REPO="${OPENCODE_FIX_REPO:-$HOME/opencode-fix}"
PG_ENV="${OPENCODE_PG_ENV:-$HOME/.config/opencode-pg/env}"
LIVE_BIN="$HOME/.opencode/bin/opencode"
PG_BIN="$HOME/.opencode/bin/opencode-pg"
PATCH_BASE_TAG_HINT="v1.17.1"   # the tag the pg patch set was first cut on
PG_BRANCH_PREFIX="feat/postgres-backend-v"

UPSTREAM_REF="origin/dev"
# The branch that actually holds the CURRENT, COMPLETE pg patch set (core pg
# commits + sync tooling + reverse migrator). This is NOT the stale
# `fork/feat/postgres-backend` remote branch (which only has the original 7
# core commits on a v1.17.1 base and is missing drizzle.pg.config.ts, so a
# rebase off it would fail at the regenerate step). Override with --patch-source.
PATCH_SOURCE="${OPENCODE_PG_PATCH_SOURCE:-feat/pg-to-sqlite-migrator}"
DO_SOAK=1
FAST_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --upstream) UPSTREAM_REF="$2"; shift 2 ;;
    --patch-source) PATCH_SOURCE="$2"; shift 2 ;;
    --no-soak)  DO_SOAK=0; shift ;;
    --fast)     FAST_BUILD=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

redact() { sed -E 's#(://[^:]+:)[^@]+#\1REDACTED#g'; }
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

cd "$REPO"

# ---- 0. sanity ------------------------------------------------------------
log "Sanity checks"
[[ -f "$PG_ENV" ]] || { echo "missing pg env file: $PG_ENV" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null || { echo "not a git repo: $REPO" >&2; exit 1; }
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "working tree is dirty; stashing." >&2
  git stash push -u -m "sync-pg-fork autostash $(date +%s)"
fi

# ---- 1. fetch upstream ----------------------------------------------------
log "Fetching remotes (origin + fork)"
git fetch origin --tags
git fetch fork --tags || true

UP_VER="$(git show "${UPSTREAM_REF}:package.json" | sed -nE 's/.*"version": *"([0-9.]+)".*/\1/p' | head -1)"
[[ -n "$UP_VER" ]] || { echo "could not read upstream version from ${UPSTREAM_REF}" >&2; exit 1; }
NEW_BRANCH="${PG_BRANCH_PREFIX}${UP_VER}"
log "Upstream ${UPSTREAM_REF} is v${UP_VER}; target branch ${NEW_BRANCH}"

# ---- 2. rebase / reapply pg patch set -------------------------------------
# The pg patch set is the run of commits on ${PATCH_SOURCE} since its
# merge-base with upstream. We rebase them onto the new upstream ref on a fresh
# branch so the diff stays reviewable.
log "Creating ${NEW_BRANCH} from ${PATCH_SOURCE} and rebasing onto ${UPSTREAM_REF}"
git rev-parse --verify "$PATCH_SOURCE" >/dev/null 2>&1 || { echo "patch source ref not found: $PATCH_SOURCE (override with --patch-source)" >&2; exit 1; }
git branch -D "$NEW_BRANCH" 2>/dev/null || true
git checkout -b "$NEW_BRANCH" "$PATCH_SOURCE"
if ! GIT_EDITOR=true git rebase "$UPSTREAM_REF"; then
  cat >&2 <<EOF

!! Rebase hit conflicts. The DB layer is the usual conflict zone:
     packages/core/src/database/database.ts   (backend wiring: keep resolvedLayer + upstream node factory)
     packages/core/src/session/sql.ts         (dialect: keep json()/double(), take upstream column TYPES)
     packages/core/src/project/sql.ts          (dialect: keep table(), take upstream type names)
   Resolve, 'git add', then: GIT_EDITOR=true git rebase --continue
   Re-run this script with --upstream ${UPSTREAM_REF} once the branch is clean, OR
   finish the rebase manually and continue from step 3 below.
EOF
  exit 1
fi

# ---- 3. regenerate the squashed pg bootstrap migration --------------------
# upstream churns the drizzle schema; the pg backend uses ONE squashed
# 0001_init.sql (it can't replay the SQLite-flavoured TS migrations). Regenerate
# it from the current dialect-aware schema so fresh pg dbs match upstream.
log "Regenerating packages/core/src/database/migration-pg/0001_init.sql from current schema"
pushd packages/core >/dev/null
rm -rf src/database/migration-pg-gen
OPENCODE_DATABASE_URL="postgres://x:x@127.0.0.1:1/x" \
  bun drizzle-kit generate --config drizzle.pg.config.ts --name init
GEN="$(ls -d src/database/migration-pg-gen/*/migration.sql | head -1)"
cp "$GEN" src/database/migration-pg/0001_init.sql
rm -rf src/database/migration-pg-gen
popd >/dev/null
if ! git diff --quiet -- packages/core/src/database/migration-pg/0001_init.sql; then
  git add packages/core/src/database/migration-pg/0001_init.sql
  git commit -m "chore(database): regenerate pg 0001_init.sql for v${UP_VER}"
  echo "   -> 0001_init.sql changed and was committed (schema drift absorbed)."
else
  echo "   -> 0001_init.sql unchanged (no pg schema drift this release)."
fi

# ---- 4. build the SEPARATE binary -----------------------------------------
log "Building opencode-pg binary (bun compile, single target)"
pushd packages/opencode >/dev/null
if [[ "$FAST_BUILD" == "1" ]]; then
  bun run script/build.ts --single --skip-embed-web-ui
else
  bun run script/build.ts --single
fi
BUILT="dist/opencode-linux-x64/bin/opencode"
[[ -x "$BUILT" ]] || { echo "build did not produce $BUILT" >&2; exit 1; }
popd >/dev/null

log "Installing to SEPARATE path ${PG_BIN} (live binary ${LIVE_BIN} untouched)"
cp "$REPO/packages/opencode/$BUILT" "$PG_BIN"
chmod +x "$PG_BIN"
echo "   opencode-pg version: $("$PG_BIN" --version)"
echo "   live opencode version: $("$LIVE_BIN" --version 2>/dev/null || echo '(unreadable)')"

# ---- 5. verify ------------------------------------------------------------
log "Verification"
# 5a. SQLite fallback intact when no env (must NOT touch pg or live opencode.db).
NOENV_N="$(env -u OPENCODE_DATABASE_URL "$PG_BIN" db "SELECT count(*)::int AS n FROM session" --format tsv | tail -1)"
echo "   [sqlite fallback, no env] session count in channel db = ${NOENV_N} (expected 0 on a fresh channel db)"
rm -f "$HOME/.local/share/opencode/opencode-feat-postgres-backend-v${UP_VER}.db"* 2>/dev/null || true

# 5b. pg read of existing data.
# shellcheck disable=SC1090
set -a; . "$PG_ENV"; set +a
echo "   [pg] using URL: $(printf '%s' "$OPENCODE_DATABASE_URL" | redact)"
PG_N="$("$PG_BIN" db "SELECT count(*)::int AS n FROM session" --format tsv | tail -1)"
echo "   [pg] existing session count = ${PG_N}"

# ---- 6. concurrency soak on a THROWAWAY db --------------------------------
if [[ "$DO_SOAK" == "1" ]]; then
  log "Concurrency soak (20 writers) on a THROWAWAY db"
  SOAK_DB="opencode_soak_$$"
  SOAK_URL="${OPENCODE_DATABASE_URL%/*}/${SOAK_DB}"
  docker exec opencode-pg psql -U opencode -d opencode -c "CREATE DATABASE ${SOAK_DB} OWNER opencode;" >/dev/null
  trap 'docker exec opencode-pg psql -U opencode -d opencode -c "DROP DATABASE IF EXISTS '"${SOAK_DB}"';" >/dev/null 2>&1 || true' EXIT
  tmp="$(mktemp -d)"
  fail=0
  for i in $(seq 1 20); do
    ( OPENCODE_DATABASE_URL="$SOAK_URL" timeout 90 "$PG_BIN" db "SELECT count(*)::int AS n FROM session" --format tsv \
        > "$tmp/w$i.out" 2>&1; echo "$?" > "$tmp/w$i.exit" ) &
  done
  wait
  for i in $(seq 1 20); do
    [[ "$(cat "$tmp/w$i.exit")" == "0" ]] || { echo "   worker $i FAILED:"; cat "$tmp/w$i.out"; fail=1; }
    grep -qiE 'lock|reserve|deadlock|too many|error|failed' "$tmp/w$i.out" && { echo "   worker $i error text:"; cat "$tmp/w$i.out"; fail=1; }
  done
  MIG_ROWS="$(docker exec opencode-pg psql -U opencode -d "$SOAK_DB" -tAc "SELECT count(*) FROM migration;")"
  rm -rf "$tmp"
  if [[ "$fail" == "0" && "$MIG_ROWS" -ge 1 ]]; then
    echo "   SOAK PASSED 20/20 (migration rows: ${MIG_ROWS})"
  else
    echo "   SOAK FAILED" >&2; exit 1
  fi
fi

log "DONE. opencode-pg @ v${UP_VER} built and verified side-by-side."
cat <<EOF

Next steps (manual, only when Gregory approves promotion to daily driver):
  1. Back up the current live binary:
       cp "$LIVE_BIN" "$LIVE_BIN.sqlite-backup-\$(date +%Y%m%d)"
  2. Promote:
       cp "$PG_BIN" "$LIVE_BIN"
  3. Ensure new shells export OPENCODE_DATABASE_URL (via ~/.zshrc sourcing $PG_ENV).
  4. Rollback if needed:
       cp "$LIVE_BIN.sqlite-backup-<date>" "$LIVE_BIN"   # or unset OPENCODE_DATABASE_URL for sqlite
  5. Keep autoupdate DISABLED (OPENCODE_DISABLE_AUTOUPDATE=1) so it can't clobber the fork again.
EOF
