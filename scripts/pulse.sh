#!/usr/bin/env bash
#
# Run a staleness sweep for every assistant.
#
# Scheduling lives in the OS, not in the app — Next has no durable scheduler and
# an in-process timer dies with the dev server. The app exposes the trigger; this
# script pulls it. Wire it to launchd with scripts/pulse.plist, or run it by hand:
#
#   npm run pulse
#
# Assistants with nothing past the stale threshold are skipped without spending a
# model call (--onlyIfStale). Pass --force to sweep regardless.

set -euo pipefail

BASE="${PULSE_BASE_URL:-http://127.0.0.1:4317}"
ONLY_IF_STALE=true
NOTIFY="${PULSE_NOTIFY:-1}"

for arg in "$@"; do
  case "$arg" in
    --force) ONLY_IF_STALE=false ;;
    --quiet) NOTIFY=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if ! curl -sf --max-time 5 "$BASE/api/state" >/dev/null; then
  echo "Personal Assistant is not answering at $BASE — start it with 'npm run dev'." >&2
  exit 1
fi

# id<TAB>name for each assistant.
ASSISTANTS=$(curl -sf "$BASE/api/state" | python3 -c '
import json, sys
for a in json.load(sys.stdin)["assistants"]:
    print(a["id"] + "\t" + a["name"])
')

swept=0
while IFS=$'\t' read -r id name; do
  [ -z "$id" ] && continue

  response=$(curl -sf -X POST "$BASE/api/pulse" \
    -H 'content-type: application/json' \
    -d "{\"assistantId\":\"$id\",\"onlyIfStale\":$ONLY_IF_STALE}" \
    --max-time 1200) || { echo "$name: sweep request failed" >&2; continue; }

  summary=$(printf '%s' "$response" | python3 -c '
import json, sys
d = json.load(sys.stdin)
counts = (d.get("scan") or {}).get("counts") or {}
if d.get("error"):
    print("ERROR\t" + str(d["error"])[:200])
elif d.get("skipped"):
    print("SKIP\t" + str(d["skipped"]))
else:
    quiet = counts.get("cold", 0) + counts.get("stale", 0) + counts.get("overdue", 0)
    print("SWEPT\t%d needing attention of %d open" % (quiet, counts.get("open", 0)))
')

  status=${summary%%$'\t'*}
  detail=${summary#*$'\t'}
  echo "$name: $detail"

  if [ "$status" = "SWEPT" ]; then
    swept=$((swept + 1))
    if [ "$NOTIFY" = "1" ] && command -v osascript >/dev/null 2>&1; then
      osascript -e "display notification \"$detail\" with title \"Pulse — $name\"" || true
    fi
  fi
done <<< "$ASSISTANTS"

echo "Done — $swept sweep(s) run."
