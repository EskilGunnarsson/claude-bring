#!/usr/bin/env bash
# Make a new CONNECTOR_TOKEN, save it as a Supabase secret, test it, and print
# the connector URL to paste into claude.ai.
#
# Usage: remote/new-token.sh <project-ref>
#   e.g. remote/new-token.sh aohzxjykjgogajayulbq
set -euo pipefail

ref="${1:-}"
if [ -z "$ref" ]; then
  echo "Usage: $0 <project-ref>" >&2
  exit 1
fi
command -v supabase >/dev/null || { echo "Install the Supabase CLI first." >&2; exit 1; }

token=$(openssl rand -hex 32)   # 64 characters
url="https://$ref.supabase.co/functions/v1/bring-mcp/$token"

supabase secrets set "CONNECTOR_TOKEN=$token" --project-ref "$ref" >/dev/null
echo "Saved CONNECTOR_TOKEN on $ref. Testing (the new secret can take a few seconds)..."

body='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bring_get_lists","arguments":{}}}'
for attempt in 1 2 3 4 5 6; do
  reply=$(curl -s --max-time 30 -X POST "$url" -H 'Content-Type: application/json' -d "$body" || true)
  case "$reply" in
    *'"isError":true'*) echo "Token works, but Bring said: $reply" >&2; break ;;
    *'"result"'*) echo "Connector works. Reply: $reply"; break ;;
    *'Not found'*|*'CONNECTOR_TOKEN secret'*) sleep 5 ;;   # old secret still cached
    *) echo "Unexpected reply: $reply" >&2; break ;;
  esac
done

echo
echo "Connector URL (keep it private, anyone with it can change your lists):"
echo "$url"
