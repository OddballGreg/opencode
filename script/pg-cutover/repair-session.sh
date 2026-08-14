#!/usr/bin/env bash
# repair-session.sh - FALLBACK repair for a session that still hits the Duo
# "assistant message prefill" 400 after reopening (i.e. the binary's built-in
# failInterruptedTools self-heal did not resolve it).
#
# Per investigation (memory #148355), the correct event-sourced fix is to append a
# RevertEvent.Committed targeting the last GOOD user message, which opencode's projector
# (packages/core/src/session/projector.ts:415-454) applies transactionally:
# deletes session_message rows with seq > boundary, cleans session_input, resets the
# context epoch, and advances event_sequence cleanly. There is NO CLI for this.
#
# STATUS: intentionally a guarded stub. Most sessions self-heal on forced resume, so this
# is expected to be rarely (if ever) needed. Build out the TS harness ONLY if a real
# session fails to self-heal, so we implement against a concrete failing case rather than
# speculatively. The harness would:
#   1. set -a; . ~/.config/opencode-pg/env; set +a
#   2. in a bun context with @opencode-ai/core, resolve the session's last USER message id,
#   3. call SessionRevert.stage({sessionID, messageID}) then SessionRevert.commit(...)
#      (packages/core/src/session/revert.ts:60,113),
#   4. verify the session's last message is now role=user (or the corrupt tail is gone).
#
# Until then, the safe manual alternative is `opencode session delete <id>` (loses that
# session) or leaving it — the migrated SQLite original remains an untouched rollback.
set -euo pipefail
SES="${1:-}"
[ -n "$SES" ] || { echo "usage: repair-session.sh <sessionID>" >&2; exit 2; }
cat >&2 <<EOF
repair-session.sh is a documented stub (see header + memory #148355).
Session requested: $SES

Recommended order:
  1. First just reopen it: opencode --postgres --session $SES  (self-heal usually fixes it).
  2. If it STILL 400s, implement the RevertEvent.Committed harness described in this file's
     header against this concrete session, or 'opencode session delete $SES' if disposable.
Not making any changes.
EOF
exit 1
