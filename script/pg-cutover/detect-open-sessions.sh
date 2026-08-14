#!/bin/sh
# detect-open-sessions.sh - Enumerate live opencode TUI processes and, where knowable,
# the session each is attached to. Read-only. Kills nothing, writes no DB.
#
# CONFIDENCE tiers:
#   CERTAIN  - the process argv carries an explicit session id (--session/-s <id>).
#              These are safe to reopen by id.
#   BARE     - a bare `opencode` TUI with NO session on argv. opencode picks a session
#              internally; we CANNOT reliably reverse it from the process (start-time and
#              "newest-in-dir" heuristics both misfire when several bare TUIs share a dir).
#              For these, the correct reopen is: relaunch bare in the same CWD and let
#              opencode-pg continue that directory's latest session (identical behaviour
#              to today). We report the CWD so the reopen script can do that.
#
# Output TSV: CONFIDENCE  PID  CWD  SESSION_ID_OR_DASH  TITLE_OR_DASH
DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"

emit() { printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5"; }

for pid in $( { pgrep -x opencode 2>/dev/null; pgrep -f '/\.opencode/bin/opencode' 2>/dev/null; } | sort -un); do
  [ -d "/proc/$pid" ] || continue
  # skip zombies/defunct (state Z) - they hold no DB handle
  [ "$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)" = "Z" ] && continue
  cl=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
  case "$cl" in
    *memory-service*|*opencode_memory*|*workflow.shim*|*oom-guard*|*-mcp*|*mcp-*|*slack*|*playwright*) continue ;;
    *"opencode serve"*) continue ;;   # shared storage server, not a single-session TUI
  esac
  # must actually be a TUI: the shim/real binary, or an explicit -s/--session launch
  case "$cl" in
    *"/.opencode/bin/opencode"*|*"opencode -s "*|*"opencode --session"*|"opencode"|"opencode "*) : ;;
    *) continue ;;
  esac

  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
  ses=$(printf '%s' "$cl" | grep -oE 'ses_[A-Za-z0-9]+' | head -1)
  if [ -n "$ses" ]; then
    title=$(sqlite3 "$DB" "SELECT COALESCE(title,'-') FROM session WHERE id='$ses';" 2>/dev/null)
    emit CERTAIN "$pid" "${cwd:-?}" "$ses" "${title:--}"
  else
    emit BARE "$pid" "${cwd:-?}" "-" "-"
  fi
done
