#!/usr/bin/env bash
# Deploy the Bring! MCP server to Cloudflare Workers. Safe to run again.
#   1. installs dependencies
#   2. creates the OAUTH_KV namespace (first run only) and writes its id into wrangler.jsonc
#   3. asks for BRING_EMAIL / BRING_PASSWORD if they aren't set as secrets yet
#   4. deploys and prints the connector URL
# Uses CLOUDFLARE_API_TOKEN if set, otherwise `wrangler login` opens a browser.
set -euo pipefail
cd "$(dirname "$0")"

npm ci --no-fund --no-audit --silent
wr() { npx --no-install wrangler "$@"; }

if ! wr whoami >/dev/null 2>&1; then wr login; fi

if grep -q REPLACE_WITH_KV_ID wrangler.jsonc; then
  out=$(wr kv namespace create OAUTH_KV 2>&1) || { echo "$out" >&2; exit 1; }
  id=$(grep -oE '"id": *"[0-9a-f]{32}"' <<<"$out" | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$id" ] || { echo "Couldn't read the KV namespace id from:" >&2; echo "$out" >&2; exit 1; }
  sed -i.bak "s/REPLACE_WITH_KV_ID/$id/" wrangler.jsonc && rm -f wrangler.jsonc.bak
  echo "Created KV namespace $id"
fi

url=$(wr deploy 2>&1 | tee /dev/stderr | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)

secrets=$(wr secret list 2>/dev/null || true)
for name in BRING_EMAIL BRING_PASSWORD; do
  if ! grep -q "\"$name\"" <<<"$secrets"; then
    echo "Enter $name (input is sent straight to Cloudflare as a secret):"
    wr secret put "$name"
  fi
done

echo
echo "Connector URL for claude.ai: ${url:-https://bring-mcp.<your-subdomain>.workers.dev}/mcp"
