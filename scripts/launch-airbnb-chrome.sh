#!/usr/bin/env bash
set -euo pipefail

port="${AIRBNB_CDP_PORT:-9226}"
profile="${AIRBNB_CHROME_PROFILE:-$HOME/.chrome-agent-profiles/airbnb}"
launcher="${AIRBNB_CDP_LAUNCHER:-$HOME/Development/homelab-agents/skills/browser-automation/scripts/launch-chrome-cdp.sh}"

if [[ ! -x "$launcher" ]]; then
  echo "Browser launcher not found or not executable: $launcher" >&2
  exit 2
fi

exec "$launcher" --port "$port" --user-data-dir "$profile" "$@"
