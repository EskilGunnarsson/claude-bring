#!/usr/bin/env bash
# Deploy the Bring! MCP server to Cloudflare Workers. Safe to run again.
#   1. installs dependencies
#   2. creates the OAUTH_KV namespace (first run only) and adds it to wrangler.jsonc
#   3. asks for BRING_EMAIL / BRING_PASSWORD if they aren't set as secrets yet
#   4. deploys; the connector URL is the printed workers.dev address + /mcp
# Uses CLOUDFLARE_API_TOKEN if set, otherwise `wrangler login` opens a browser.
set -euo pipefail
cd "$(dirname "$0")"

npm ci --no-fund --no-audit --silent
wr() { npx --no-install wrangler "$@"; }

if ! wr whoami >/dev/null 2>&1; then wr login; fi

if ! grep -q '"OAUTH_KV"' wrangler.jsonc; then
  wr kv namespace create OAUTH_KV --binding OAUTH_KV --update-config
  grep -q '"OAUTH_KV"' wrangler.jsonc || { echo "The OAUTH_KV binding wasn't added to wrangler.jsonc." >&2; exit 1; }
fi

# Run directly (not piped) so Wrangler can ask you to pick a workers.dev subdomain on first use.
wr deploy

secrets=$(wr secret list 2>/dev/null || true)
for name in BRING_EMAIL BRING_PASSWORD; do
  if ! grep -q "\"$name\"" <<<"$secrets"; then
    echo "Enter $name (input is sent straight to Cloudflare as a secret):"
    wr secret put "$name"
  fi
done

echo
echo "Done. Your connector URL is the https://bring-mcp.….workers.dev address printed by the"
echo "deploy above, with /mcp added to the end."
