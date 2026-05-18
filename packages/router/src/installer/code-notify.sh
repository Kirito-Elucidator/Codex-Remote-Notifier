#!/usr/bin/env bash
# code-notify — Send a notification via Remote Notifier
# Installed by the Remote Notifier VS Code extension
#
# Usage:
#   code-notify "Title" "Message"
#   code-notify "Message"
#   code-notify -l warning "Title" "Message"
#   code-notify -l error "Message"

set -euo pipefail

_json_escape() {
  local str="$1"
  str="${str//\\/\\\\}"
  str="${str//\"/\\\"}"
  str="${str//$'\n'/\\n}"
  str="${str//$'\r'/\\r}"
  str="${str//$'\t'/\\t}"
  printf '%s' "$str"
}

level="information"
display_hint=""
icon_key=""
sound_key=""
title=""
message=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -l|--level) level="$2"; shift 2 ;;
    -d|--display) display_hint="$2"; shift 2 ;;
    -i|--icon) icon_key="$2"; shift 2 ;;
    -s|--sound) sound_key="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: code-notify [-l level] [-d display] [-i icon] [-s sound] [title] <message>"
      echo "       code-notify [-l level] [-d display] [-i icon] [-s sound] <message>"
      echo ""
      echo "  -l, --level    information|warning|error (default: information)"
      echo "  -d, --display  app|system (hint for notification display mode)"
      echo "  -i, --icon     icon key name (mapped to a file path in main extension settings)"
      echo "  -s, --sound    sound key name (mapped to a file path in main extension settings)"
      echo ""
      echo "If two positional arguments are given, the first is the title."
      exit 0
      ;;
    *)
      if [[ -z "$title" ]]; then
        title="$1"
      elif [[ -z "$message" ]]; then
        message="$1"
      fi
      shift
      ;;
  esac
done

# If only one positional arg was given, it's the message, not the title
if [[ -z "$message" ]]; then
  message="$title"
  title=""
fi

if [[ -z "$message" ]]; then
  echo "code-notify: message is required" >&2
  echo "Usage: code-notify [-l level] [title] <message>" >&2
  exit 1
fi

port="${REMOTE_NOTIFIER_PORT:-}"
token="${REMOTE_NOTIFIER_TOKEN:-}"
url="${REMOTE_NOTIFIER_URL:-}"

if [[ -z "$port" || -z "$token" ]]; then
  session_file="$HOME/.remote-notifier/session.json"
  if [[ -f "$session_file" ]]; then
    port=$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$session_file" | grep -o '[0-9]*')
    token=$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$session_file" | sed 's/.*"token"[[:space:]]*:[[:space:]]*"//;s/"$//')
  fi
fi

if [[ -z "$port" || -z "$token" ]]; then
  echo "code-notify: cannot find Remote Notifier session (is VS Code running?)" >&2
  exit 1
fi

[[ -z "$url" ]] && url="http://127.0.0.1:${port}/notify"

escaped_message=$(_json_escape "$message")
json="{\"message\":\"$escaped_message\",\"level\":\"$level\""

if [[ -n "$title" ]]; then
  escaped_title=$(_json_escape "$title")
  json+=",\"title\":\"$escaped_title\""
fi

if [[ -n "$display_hint" ]]; then
  json+=",\"display_hint\":\"$display_hint\""
fi

if [[ -n "$icon_key" ]]; then
  escaped_icon_key=$(_json_escape "$icon_key")
  json+=",\"icon\":\"$escaped_icon_key\""
fi

if [[ -n "$sound_key" ]]; then
  escaped_sound_key=$(_json_escape "$sound_key")
  json+=",\"sound\":\"$escaped_sound_key\""
fi

json+="}"

http_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 -m 10 -X POST "$url" \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -d "$json" 2>/dev/null || true)

if [[ "$http_code" == "200" ]]; then
  exit 0
elif [[ "$http_code" == "000" ]]; then
  echo "code-notify: could not connect to Remote Notifier server" >&2
  exit 1
else
  echo "code-notify: server returned HTTP $http_code" >&2
  exit 1
fi
