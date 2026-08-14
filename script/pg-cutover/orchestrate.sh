#!/usr/bin/env bash
# orchestrate.sh - Fully hand-held opencode SQLite -> Postgres cutover.
#
# Run from a PLAIN terminal with nohup so it survives the terminal closing:
#   nohup bash ~/opencode-fix/script/pg-cutover/orchestrate.sh & tail -f ~/.local/share/opencode/cutover-backups/orchestrate.log
# It:
#   1. Snapshots currently-open sessions (for reopen) + records memory-service state.
#   2. Gracefully stops the memory systemd service (frees the model RAM, halts bg workers).
#   3. Gracefully terminates all opencode TUIs + `opencode serve` (SIGTERM, wait, SIGKILL).
#   4. Waits for full quiescence, then runs cutover.sh --yes (checkpoint/backup/fresh-init/migrate/verify).
#   5. Restarts the memory service.
#   6. Writes ready-to-run reopen commands + a DONE/FAILED marker to the log.
#
# It NEVER modifies the live SQLite db (cutover uses it read-only + snapshots it).
# All output goes to $LOG. Tail it:  tail -f ~/.local/share/opencode/cutover-backups/orchestrate.log
set -uo pipefail

REPO="${OPENCODE_FIX_REPO:-$HOME/opencode-fix}"
CO="$REPO/script/pg-cutover"
BACKUP_DIR="${OPENCODE_CUTOVER_BACKUPS:-$HOME/.local/share/opencode/cutover-backups}"
LOG="$BACKUP_DIR/orchestrate.log"
SNAP="$BACKUP_DIR/open-sessions.tsv"
REOPEN="$BACKUP_DIR/reopen-commands.sh"
MEM_UNIT="opencode-memory"

mkdir -p "$BACKUP_DIR"
: > "$LOG"
exec >>"$LOG" 2>&1

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '\n[%s] ==> %s\n' "$(ts)" "$*"; }
fail() { printf '\n[%s] !!! FAILED: %s\n' "$(ts)" "$*"; printf 'CUTOVER FAILED\n'; restart_memory; exit 1; }

MEM_CTL="$HOME/gitlab_projects/worktrees/memory-service/scripts/memory-ctl.sh"
restart_memory() {
  log "Restarting services (memory + oom-guard)"
  systemctl --user start opencode-oom-guard 2>&1 || log "  (oom-guard start skipped)"
  if systemctl --user start "$MEM_UNIT" 2>&1; then
    return 0
  fi
  [ -x "$MEM_CTL" ] && "$MEM_CTL" start 2>&1 && return 0
  log "WARN: could not restart memory automatically - run: systemctl --user start $MEM_UNIT"
}

log "ORCHESTRATED CUTOVER START (pid $$)"

# ---- 1. snapshot open sessions ---------------------------------------------
# If a prior run already captured a snapshot (e.g. a previous aborted cutover that
# had already killed the TUIs), DO NOT overwrite it - recapturing now would only see
# this orchestrator's own shell and lose the real session list. Merge: keep existing
# rows, add any currently-live ones we haven't seen.
NOW_SNAP="$(mktemp)"
"$CO/detect-open-sessions.sh" 2>/dev/null | sort -u > "$NOW_SNAP" || true
if [ -s "$SNAP" ] && awk -F'\t' '$1=="CERTAIN"&&$4!="-"' "$SNAP" | grep -q .; then
  log "Reusing existing snapshot ($SNAP) and merging any new live sessions"
  cat "$SNAP" "$NOW_SNAP" | sort -u > "$SNAP.merged" && mv "$SNAP.merged" "$SNAP"
else
  log "Capturing fresh snapshot -> $SNAP"
  cp "$NOW_SNAP" "$SNAP"
fi
rm -f "$NOW_SNAP"
cat "$SNAP"
CERTAIN_N=$(awk -F'\t' '$1=="CERTAIN"&&$4!="-"{print $4}' "$SNAP" | sort -u | wc -l | tr -d ' ')
BARE_N=$(awk -F'\t' '$1=="BARE"{print $3}' "$SNAP" | sort -u | wc -l | tr -d ' ')
log "Will reopen: $CERTAIN_N session(s) by id + $BARE_N bare cwd(s)"

# ---- 2. stop memory service + oom-guard (so nothing respawns a TUI) --------
log "Stopping opencode-oom-guard (prevents it respawning a session mid-cutover)"
systemctl --user stop opencode-oom-guard 2>&1 || log "  (oom-guard stop skipped)"

log "Stopping memory service ($MEM_UNIT) - frees model RAM + halts bg workers"
systemctl --user stop "$MEM_UNIT" 2>&1 || \
  "$HOME/gitlab_projects/worktrees/memory-service/scripts/memory-ctl.sh" stop 2>&1 || \
  log "WARN: systemctl stop failed; will still proceed"
sleep 2
# belt-and-braces: kill any lingering memory shim/daemon procs
pkill -TERM -f 'opencode_memory' 2>/dev/null || true
sleep 1

# ---- 3. terminate opencode TUIs + serve -----------------------------------
log "Terminating opencode TUIs + serve (graceful SIGTERM)"
# Collect target pids: real binaries/shim + explicit-session + serve. Exclude THIS script.
collect_pids() {
  { pgrep -x opencode 2>/dev/null
    pgrep -f '/\.opencode/bin/opencode' 2>/dev/null
    pgrep -f 'opencode serve' 2>/dev/null
  } | sort -un | while read -r p; do
      [ "$p" = "$$" ] && continue
      [ -d "/proc/$p" ] || continue
      # skip zombies/defunct (state Z) - already dead, cannot be killed/reaped here
      [ "$(awk '{print $3}' "/proc/$p/stat" 2>/dev/null)" = "Z" ] && continue
      # skip anything that is this orchestrator or its subshell
      case "$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)" in
        *orchestrate.sh*) continue ;;
      esac
      echo "$p"
    done
}
PIDS=$(collect_pids)
echo "target pids: $(echo $PIDS | tr '\n' ' ')"
[ -n "$PIDS" ] && kill -TERM $PIDS 2>/dev/null || true

# wait up to 20s for graceful exit
for i in $(seq 1 20); do
  REMAIN=$(collect_pids)
  [ -z "$REMAIN" ] && break
  sleep 1
done
REMAIN=$(collect_pids)
if [ -n "$REMAIN" ]; then
  log "Escalating to SIGKILL for stragglers: $(echo $REMAIN | tr '\n' ' ')"
  kill -KILL $REMAIN 2>/dev/null || true
  sleep 2
fi

# ---- 4. confirm quiescence (zombie-aware) ----------------------------------
log "Confirming quiescence"
LIVE=$("$CO/detect-open-sessions.sh" 2>/dev/null | grep -c . || true)
LIVE_SERVE=$(collect_pids | wc -l | tr -d ' ')
echo "  live TUI:$LIVE live serve+shim:$LIVE_SERVE (zombies ignored)"
[ "$LIVE" = "0" ] || fail "live TUIs remain after SIGKILL: $("$CO/detect-open-sessions.sh")"

# ---- 5. run the cutover ----------------------------------------------------
log "Running cutover.sh --yes"
if "$CO/cutover.sh" --yes; then
  log "cutover.sh succeeded"
else
  fail "cutover.sh returned non-zero (see above)"
fi

# ---- 6. restart memory -----------------------------------------------------
restart_memory

# ---- 7. write + AUTO-LAUNCH reopen ----------------------------------------
log "Writing reopen commands -> $REOPEN"
"$CO/reopen.sh" "$SNAP" > "$REOPEN" 2>&1 || true
chmod +x "$REOPEN" 2>/dev/null || true
cat "$REOPEN"

# Pick a terminal emulator / multiplexer to spawn each session in its own window.
spawn_term() {  # $1 = "cd <cwd> && <cmd...>"
  local shellcmd="$1"
  if command -v tmux >/dev/null 2>&1; then
    tmux new-window -d "sh -lc '$shellcmd; exec zsh'" 2>/dev/null && return 0
  fi
  for T in ghostty kitty wezterm alacritty gnome-terminal konsole xterm; do
    command -v "$T" >/dev/null 2>&1 || continue
    case "$T" in
      gnome-terminal) nohup "$T" -- zsh -lc "$shellcmd; exec zsh" >/dev/null 2>&1 & return 0 ;;
      konsole)        nohup "$T" -e zsh -lc "$shellcmd; exec zsh" >/dev/null 2>&1 & return 0 ;;
      *)              nohup "$T" -e zsh -lc "$shellcmd; exec zsh" >/dev/null 2>&1 & return 0 ;;
    esac
  done
  return 1
}

log "Auto-launching reopened sessions on Postgres"
launched=0; failed=0
# CERTAIN: by id
while IFS="$(printf '\t')" read -r ses cwd; do
  [ -n "$ses" ] || continue
  if spawn_term "cd $(printf '%q' "$cwd") && $HOME/.opencode/bin/opencode --postgres --session $ses"; then
    echo "  launched $ses in $cwd"; launched=$((launched+1))
  else failed=$((failed+1)); fi
done <<EOF2
$(awk -F'\t' '$1=="CERTAIN" && $4!="-" {print $4"\t"$3}' "$SNAP" | sort -u)
EOF2
# BARE: one per cwd
while IFS= read -r cwd; do
  [ -n "$cwd" ] && [ "$cwd" != "?" ] || continue
  if spawn_term "cd $(printf '%q' "$cwd") && $HOME/.opencode/bin/opencode --postgres"; then
    echo "  launched bare TUI in $cwd"; launched=$((launched+1))
  else failed=$((failed+1)); fi
done <<EOF3
$(awk -F'\t' '$1=="BARE"{print $3}' "$SNAP" | sort -u)
EOF3

log "ORCHESTRATED CUTOVER COMPLETE (launched=$launched, spawn_failures=$failed)"
printf '\nCUTOVER SUCCESS\n'
if [ "$failed" != "0" ] || [ "$launched" = "0" ]; then
  printf '\nSome sessions could not be auto-launched (no terminal/tmux found).\nReopen manually:\n  sh %s\n' "$REOPEN"
fi
