#!/bin/sh
# detect-corrupted-sessions.sh - Find sessions that will hit the Duo "assistant message
# prefill" 400 on resume: their last message is an assistant turn that was interrupted
# mid-flight (finish IS NULL) with a tool part still in state 'running' and no step-finish.
#
# IMPORTANT: a session that is OPEN RIGHT NOW legitimately has such a tail (it's mid-turn).
# Those are FALSE POSITIVES. We exclude any session id currently held by a live TUI
# (from detect-open-sessions.sh CERTAIN rows) and, conservatively, also flag but mark
# any session updated in the last ACTIVE_WINDOW_MIN minutes as LIVE? for review.
#
# Read-only. Output TSV: STATUS  LAST_ACTIVITY  SESSION_ID  TITLE
#   STATUS = CORRUPT (safe to repair) | LIVE? (recent/open, review before touching)
DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
ACTIVE_WINDOW_MIN="${ACTIVE_WINDOW_MIN:-20}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Build exclusion set: session ids currently attached to a live TUI (CERTAIN only).
LIVE_IDS=$("$HERE/detect-open-sessions.sh" 2>/dev/null | awk -F'\t' '$1=="CERTAIN"{print $4}' | sort -u)
# SQL IN-list (quoted). Empty -> harmless ('').
IN_LIST="''"
for id in $LIVE_IDS; do IN_LIST="$IN_LIST,'$id'"; done

NOW_MS=$(( $(date +%s) * 1000 ))
WIN_MS=$(( ACTIVE_WINDOW_MIN * 60 * 1000 ))

sqlite3 -separator '	' "$DB" "
WITH last_msg AS (
  SELECT m.id, m.session_id, m.data, m.time_created,
         ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC, m.id DESC) rn
  FROM message m
),
broken AS (
  SELECT DISTINCT lm.session_id, lm.time_created
  FROM last_msg lm
  JOIN part p ON p.message_id = lm.id
  WHERE lm.rn = 1
    AND json_extract(lm.data,'\$.role') = 'assistant'
    AND json_extract(lm.data,'\$.finish') IS NULL
    AND json_extract(p.data,'\$.type') = 'tool'
    AND json_extract(p.data,'\$.state.status') = 'running'
)
SELECT
  CASE WHEN ($NOW_MS - b.time_created) < $WIN_MS THEN 'LIVE?' ELSE 'CORRUPT' END AS status,
  datetime(b.time_created/1000,'unixepoch') AS last_activity,
  b.session_id,
  COALESCE(s.title,'-') AS title
FROM broken b
LEFT JOIN session s ON s.id = b.session_id
WHERE b.session_id NOT IN ($IN_LIST)
ORDER BY b.time_created DESC;
"
