#!/usr/bin/env bash
# reopen.sh - After a cutover, reopen the sessions that were open, on the Postgres fork.
#
# Reads a captured snapshot of open sessions (from detect-open-sessions.sh, saved BEFORE
# you closed the TUIs) and prints the exact commands to relaunch each on opencode-pg:
#   CERTAIN rows -> `opencode --postgres --session <id>` in the original cwd
#   BARE rows    -> `opencode --postgres` in the original cwd (continues that dir's latest)
#
# It does NOT auto-spawn terminals (that depends on your terminal/multiplexer). It prints a
# ready-to-run block, and can optionally launch detached `opencode serve`-free TUIs if asked.
#
# Usage:
#   # BEFORE closing anything, capture the snapshot:
#   script/pg-cutover/detect-open-sessions.sh > /tmp/opencode-open-sessions.tsv
#   # ...close all TUIs, run cutover.sh --yes...
#   script/pg-cutover/reopen.sh /tmp/opencode-open-sessions.tsv
set -euo pipefail

SNAP="${1:-/tmp/opencode-open-sessions.tsv}"
SHIM="$HOME/.opencode/bin/opencode"
[ -f "$SNAP" ] || { echo "snapshot not found: $SNAP (run detect-open-sessions.sh > $SNAP BEFORE closing TUIs)" >&2; exit 1; }

echo "# Reopen commands (Postgres fork via shim --postgres). Review, then paste into terminals/tmux."
echo "# CERTAIN = resume exact session by id; BARE = continue that directory's latest session."
echo

# CERTAIN: unique (session_id, cwd)
awk -F'\t' '$1=="CERTAIN" && $4!="-" {print $4"\t"$3}' "$SNAP" | sort -u | while IFS=$(printf '\t') read -r ses cwd; do
  printf '( cd %q && %q --postgres --session %s )\n' "$cwd" "$SHIM" "$ses"
done

# BARE: unique cwd (one relaunch per distinct working dir)
awk -F'\t' '$1=="BARE" {print $3}' "$SNAP" | sort -u | while IFS= read -r cwd; do
  [ -n "$cwd" ] && [ "$cwd" != "?" ] || continue
  printf '( cd %q && %q --postgres )\n' "$cwd" "$SHIM"
done

echo
echo "# If a reopened session still errors with the prefill 400, it did not self-heal;"
echo "# run the RevertEvent fallback (script/pg-cutover/repair-session.sh <id>) - see memory #148355."
