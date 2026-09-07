#!/usr/bin/env bash
# opencode launch-shim integrity guard.
#
# ~/.opencode/bin/opencode is a SHIM (a small POSIX script) that dispatches to
# either opencode-stock (upstream SQLite build) or opencode-pg (the Postgres
# fork). Keeping the fork behind a shim is what prevents the SQLite
# single-writer corruption class from returning.
#
# THE PROBLEM THIS GUARD EXISTS FOR:
#   opencode's own installer hardcodes its target directory --
#   `INSTALL_DIR=$HOME/.opencode/bin` in https://opencode.ai/install -- and
#   writes a binary literally named `opencode`. That is the shim's exact path.
#   So ANY installer run replaces the shim with a stock ELF:
#     * curl -fsSL https://opencode.ai/install | bash  (docs, devcontainers,
#       another tool's bootstrap, a manual re-install)
#     * `opencode upgrade` invoked on a binary that is not behind the shim
#   Autoupdate is NOT the vector: `autoupdate: false` in opencode.json and
#   OPENCODE_DISABLE_AUTOUPDATE=1 are both set, and cli/upgrade.ts returns early
#   on either. The shim's exec-based self-protection only stops opencode
#   upgrading ITSELF through the shim; it cannot stop an external writer.
#   Confirmed clobber: 2026-09-02 23:17 (a v1.18.27 stock ELF landed on the
#   shim path with both guards set).
#
# WHAT THIS DOES:
#   Compares the installed shim against the canonical source (now tracked in
#   git at ~/opencode-fix/scripts/opencode-shim.sh) and restores it on drift.
#   A clobbering binary is preserved rather than deleted -- it is usually a
#   legitimately NEWER stock build, so it is salvaged into opencode-stock when
#   it is a real upgrade, exactly as the 2026-09-04 manual repair did.
#
# Deterministic: pure file comparison, no LLM, zero token cost.

set -euo pipefail

BIN_DIR="${OPENCODE_BIN_DIR:-$HOME/.opencode/bin}"
SHIM="$BIN_DIR/opencode"
STOCK="$BIN_DIR/opencode-stock"
CANONICAL="${OPENCODE_SHIM_SOURCE:-$HOME/opencode-fix/scripts/opencode-shim.sh}"
STATE_DIR="${STATE_DIR:-${XDG_RUNTIME_DIR:-/tmp}}"
LOG="$STATE_DIR/opencode-shim-guard.log"
STAMP="$(date +%Y%m%d-%H%M%S)"

# notify-send needs a session bus; fill it in if we were launched detached.
export DISPLAY="${DISPLAY:-:0}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"

log() { echo "$(date +%F' '%T) $*" | tee -a "$LOG"; }

notify() {
  notify-send -u "${1}" -a "opencode-shim-guard" "${2}" "${3}" 2>>"$LOG" || true
}

if [[ ! -f "$CANONICAL" ]]; then
  log "ERROR: canonical shim source missing at $CANONICAL; cannot verify. Leaving everything alone."
  notify critical "opencode shim guard broken" "Canonical shim source missing at $CANONICAL - cannot verify or restore."
  exit 1
fi

if [[ ! -e "$SHIM" ]]; then
  log "shim ABSENT at $SHIM; installing from canonical source."
  install -m 755 "$CANONICAL" "$SHIM"
  notify normal "opencode shim restored" "The shim was missing and has been reinstalled from the tracked source."
  exit 0
fi

# Fast path: byte-identical means nothing to do. This is the expected outcome.
if cmp -s "$SHIM" "$CANONICAL"; then
  log "ok: shim matches canonical source (no drift)."
  exit 0
fi

# --- drift ------------------------------------------------------------------
size="$(stat -c %s "$SHIM" 2>/dev/null || echo 0)"
log "DRIFT: $SHIM differs from $CANONICAL (installed size ${size} bytes)."

# Preserve whatever is there before overwriting it.
backup="$SHIM.clobbered-$STAMP"
cp -p "$SHIM" "$backup"
log "backed up the clobbering file -> $backup"

# A clobber is typically a stock ELF, and often a NEWER one than the
# opencode-stock we keep. Salvage it in that case so the stock slot moves
# forward instead of stranding a good build in a backup file.
salvaged=""
if [[ ! -x "$SHIM" ]]; then
  : # not executable; nothing to salvage
elif clobber_version="$("$SHIM" --version 2>/dev/null | tr -d '[:space:]')" && [[ -n "$clobber_version" ]]; then
  stock_version="$("$STOCK" --version 2>/dev/null | tr -d '[:space:]' || echo "")"
  if [[ "$clobber_version" != "$stock_version" ]]; then
    newest="$(printf '%s\n%s\n' "$clobber_version" "$stock_version" | sort -V | tail -1)"
    if [[ "$newest" == "$clobber_version" ]]; then
      cp -p "$STOCK" "$STOCK.pre-salvage-$STAMP" 2>/dev/null || true
      # Stage + atomic rename: a plain cp over a running binary fails ETXTBSY.
      stage="$BIN_DIR/.opencode-stock.new.$$"
      cp "$SHIM" "$stage" && chmod +x "$stage" && mv -f "$stage" "$STOCK"
      salvaged="$clobber_version"
      log "salvaged the clobbering build ($clobber_version) into opencode-stock (was ${stock_version:-unknown})."
    fi
  fi
fi

# Restore the shim via stage + atomic rename, for the same ETXTBSY reason: a
# live session may be executing the old file, and rename swaps the directory
# entry without touching the running inode.
stage="$BIN_DIR/.opencode.new.$$"
cp "$CANONICAL" "$stage"
chmod 755 "$stage"
mv -f "$stage" "$SHIM"

if cmp -s "$SHIM" "$CANONICAL"; then
  log "RESTORED: shim now matches the canonical source."
else
  log "ERROR: restore did not verify; $SHIM still differs from $CANONICAL."
  notify critical "opencode shim restore FAILED" "Drift detected but the restore did not verify. Investigate $LOG."
  exit 1
fi

body="Shim was clobbered and has been restored from the tracked source."
[[ -n "$salvaged" ]] && body="$body Salvaged $salvaged into opencode-stock."
body="$body Backup: $(basename "$backup")"
notify normal "opencode shim restored" "$body"
log "done."
