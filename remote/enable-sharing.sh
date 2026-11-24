#!/usr/bin/env bash
# Turn on sharing: friends sign up with their own Bring account and get their own
# connector URL. Run from anywhere; needs the Supabase CLI, logged in.
#
# Usage: remote/enable-sharing.sh <project-ref> [github-pages-base-url]
#   e.g. remote/enable-sharing.sh aohzxjykjgogajayulbq https://eskilgunnarsson.github.io/claude-bring
set -euo pipefail

ref="${1:-}"
pages="${2:-https://eskilgunnarsson.github.io/claude-bring}"
if [ -z "$ref" ]; then
  echo "Usage: $0 <project-ref> [github-pages-base-url]" >&2
  exit 1
fi
command -v supabase >/dev/null || { echo "Install the Supabase CLI first." >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"

existing=$(supabase secrets list --project-ref "$ref" 2>/dev/null || true)

# Never replace an existing ENCRYPTION_KEY: everyone who signed up would be locked out.
if grep -q ENCRYPTION_KEY <<<"$existing"; then
  echo "ENCRYPTION_KEY already set, keeping it."
else
  supabase secrets set "ENCRYPTION_KEY=$(openssl rand -hex 32)" --project-ref "$ref" >/dev/null
  echo "Set ENCRYPTION_KEY."
fi

code="${SIGNUP_CODE:-$(openssl rand -hex 6)}"
supabase secrets set "SIGNUP_CODE=$code" --project-ref "$ref" >/dev/null
echo "Set SIGNUP_CODE (the invite code in the sign-up link)."

(cd "$here" && supabase functions deploy bring-mcp --project-ref "$ref" --no-verify-jwt)

sql="$here/supabase/migrations/20261124120000_bring_users.sql"
if command -v pbcopy >/dev/null; then pbcopy <"$sql"; copied=" (it's on your clipboard now)"; else copied=""; fi
cat <<MSG

One step left: create the table for sign-ups. Open
  https://supabase.com/dashboard/project/$ref/sql/new
paste the contents of
  $sql$copied
and click Run. It's safe to run more than once.

Then send friends this sign-up link:
  $pages/signup.html#ref=$ref&code=$code

Anyone with the link can sign up, so share it only with people you trust. To stop new
sign-ups, run this script again: it makes a new invite code and the old link stops working.
MSG
