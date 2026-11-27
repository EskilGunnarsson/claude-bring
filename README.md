# Bring! for Claude

Let Claude manage your [Bring!](https://www.getbring.com) shopping lists: see what's on a list, add items with quantities or notes, mark items as bought, and remove them.

It works in three places:

- **Claude desktop app (regular chat):** as a local MCP connector called `bring`.
- **Claude Code:** as a skill, so you can say "add oat milk to the Bring list" in a coding session.
- **Claude on your phone and claude.ai, any time:** as a remote connector on Cloudflare Workers, with OAuth sign-in. It keeps working when your computer is off.

Built on [`bring-api`](https://github.com/miaucl/bring-api), the unofficial Python library also used by Home Assistant's Bring integration. Bring has no official public API, so this can break if Bring changes theirs.

## Install (macOS)

Requires Python 3.10 or newer and git.

```bash
git clone https://github.com/EskilGunnarsson/claude-bring.git ~/.claude/skills/bring
~/.claude/skills/bring/install.sh
```

The install script:

1. creates a Python environment in `.venv` inside the repo,
2. creates `~/.config/bring-skill/credentials`, readable only by you,
3. links the Claude Code skill if you cloned somewhere other than `~/.claude/skills/bring`,
4. adds a `bring` entry under `mcpServers` in Claude Desktop's `claude_desktop_config.json` (it saves a backup first). Pass `--no-desktop` to skip this.

Then:

1. Put your Bring! login in `~/.config/bring-skill/credentials`:
   ```
   BRING_EMAIL=you@example.com
   BRING_PASSWORD=your-password
   ```
2. Check that the login works:
   ```bash
   ~/.claude/skills/bring/.venv/bin/python ~/.claude/skills/bring/scripts/bring_cli.py lists
   ```
3. Quit and reopen the Claude desktop app. `bring` now shows up in a chat's connectors.

Your password stays on your computer. It's read from that file (or from the `BRING_EMAIL` / `BRING_PASSWORD` environment variables) and sent only to Bring's API.

## Using it

In a Claude chat, just ask:

- "What's on my Bring list?"
- "Add milk (2 l), eggs and bread to the Groceries list"
- "I bought the eggs and bread"
- "Remove bananas from the Party list"

If you don't name a list, your Bring default list is used. Item names follow the list's language, so a German list says "Milch", not "Milk".

### MCP tools

| Tool | What it does |
|---|---|
| `bring_get_lists` | All lists on the account |
| `bring_show_list` | Items to buy (optionally recently bought too) |
| `bring_add_items` | Add items, each with an optional spec like "2 l" |
| `bring_complete_items` | Mark items as bought |
| `bring_remove_items` | Remove items without marking them bought |

### Command line

```bash
alias bring="~/.claude/skills/bring/.venv/bin/python ~/.claude/skills/bring/scripts/bring_cli.py"
bring lists
bring show --list Groceries --recent
bring add "Milk:2 l" Eggs Bread
bring complete Eggs --dry-run
bring --json show
```

## Phone and claude.ai, always on (Cloudflare Workers)

The local connector runs on your Mac. When the Mac is off, the Claude phone app and claude.ai
can't reach it. The Worker in [`remote/cloudflare`](remote/cloudflare) runs the same five tools on
Cloudflare's free plan, so it's always reachable. The local connector stays as a fallback; you
can keep both.

- **Your Bring login lives in Worker secrets** (`BRING_EMAIL`, `BRING_PASSWORD`, optionally `BRING_LIST`).
- **The endpoint is behind OAuth.** When you connect it in claude.ai, a sign-in page opens. It
  only accepts the Bring login stored in those secrets, and it locks out an IP address after
  10 wrong tries in an hour. claude.ai then gets a token and refreshes it for a year.

### Deploy

Requires Node.js 18 or newer.

```bash
cd ~/.claude/skills/bring
git pull
remote/cloudflare/setup.sh
```

The script:

1. installs dependencies,
2. signs you in to Cloudflare in the browser,
3. creates a KV namespace for OAuth data and adds it to `wrangler.jsonc`,
4. deploys,
5. asks for your Bring email and password, and stores them as Worker secrets.

Your connector URL is the `https://bring-mcp.<your-subdomain>.workers.dev` address the deploy prints, with `/mcp` added: `https://bring-mcp.<your-subdomain>.workers.dev/mcp`.

To check it before using it from Claude, run the test script. It does the whole OAuth flow, then
adds a test item to the list and removes it:

```bash
read -s "PW?Bring password: "; export PW
LIVE="The Atelier" node remote/cloudflare/test-flow.mjs https://bring-mcp.<your-subdomain>.workers.dev you@example.com
```

### Add it to claude.ai

1. On claude.ai, open **Settings → Connectors**. If an old **Bring** connector is listed, remove it.
2. Choose **Add custom connector**. Name it `Bring` and use the `…workers.dev/mcp` URL. Leave the
   OAuth client ID and secret empty: claude.ai registers itself.
3. Click **Connect**. On the sign-in page, enter your Bring email and password.
4. On your phone, close and reopen the Claude app. In a chat, tap **+** and turn on **Bring**.

To cut off access, remove the connector on claude.ai. To lock out every connected client, delete
the `OAUTH_KV` namespace's keys in the Cloudflare dashboard, or change your Bring password and
run `npx wrangler secret put BRING_PASSWORD` in `remote/cloudflare`.

## Phone and claude.ai via Supabase (alternative)

The connector above runs on your Mac, so the Claude phone app and claude.ai in a browser can't reach it. For those, deploy the TypeScript version in [`remote/`](remote/supabase/functions/bring-mcp) as a free [Supabase](https://supabase.com) Edge Function, then add it to claude.ai as a custom connector. Connectors added on claude.ai also show up in the phone app.

1. Create a Supabase project (the free plan is enough) and note its project ref, the `abcd…` part of `https://abcd….supabase.co`.
2. Deploy the function:
   ```bash
   cd remote
   supabase login
   supabase functions deploy bring-mcp --project-ref <project-ref>
   ```
3. In the Supabase dashboard, go to **Edge Functions → Secrets** and add:
   - `BRING_EMAIL` and `BRING_PASSWORD`: your Bring! login
   - `CONNECTOR_TOKEN`: a long random string. Make one with `openssl rand -hex 32`.
4. On claude.ai, go to **Settings → Connectors → Add custom connector**. Leave the advanced OAuth settings empty and use this URL:
   ```
   https://<project-ref>.supabase.co/functions/v1/bring-mcp/<CONNECTOR_TOKEN>
   ```

**Anyone who has the full URL can read and change your lists**, so treat it like a password. To revoke access, change `CONNECTOR_TOKEN` and update the connector URL.

Free Supabase projects are paused after 7 days of inactivity, and then the connector stops working. To prevent that, this repo has a GitHub Actions workflow ([`supabase-keepalive.yml`](.github/workflows/supabase-keepalive.yml)) that pings the project every 3 days. To turn it on, add two repository secrets under **Settings → Secrets and variables → Actions**:

- `SUPABASE_URL`: `https://<project-ref>.supabase.co`
- `SUPABASE_ANON_KEY`: the project's anon (publishable) key, from **Project Settings → API Keys**

If the project gets paused anyway, a workflow run fails and GitHub emails you. Restore the project in the Supabase dashboard. GitHub turns off scheduled workflows in repos with no commits for 60 days. If that happens, re-enable the workflow in the Actions tab.

If the connector disappears from claude.ai, add it again with the same URL. Supabase doesn't show secret values after you save them, so if you no longer have `CONNECTOR_TOKEN`, set a new one and use that in the URL.

## Sharing with friends (their own Bring account)

Friends can use your connector with **their own** Bring lists. They open a sign-up page,
enter their Bring login once, and get a personal connector URL. Everything runs in your
Supabase project. They don't need a Supabase account.

How it works:

- Their Bring password is used once to sign in to Bring and is never stored. The function
  keeps only Bring's refresh token, encrypted with the `ENCRYPTION_KEY` secret, in the
  `bring_users` table.
- Their connector URL is stored only as a hash. Each URL can reach only that person's lists.
- Your own `CONNECTOR_TOKEN` URL keeps working with your account as before.
- Signing up again gives a new URL and turns off the old one. The page also has a
  **Stop using it** button that deletes their sign-in.

Setup (once):

1. Turn on GitHub Pages for this repo: **Settings → Pages → Deploy from a branch → `main` / `docs`**.
2. Run the script. It sets the `ENCRYPTION_KEY` and `SIGNUP_CODE` secrets and deploys the function:
   ```bash
   remote/enable-sharing.sh <project-ref>
   ```
3. Run the SQL it points to (`remote/supabase/migrations/…_bring_users.sql`) in the Supabase SQL editor.
4. Send friends the sign-up link it prints:
   `https://<you>.github.io/claude-bring/signup.html#ref=<project-ref>&code=<invite code>`

Only people with the invite code can sign up. To close sign-ups, run the script again. It
makes a new code, and the old link stops working. Existing friends keep access.

You're holding your friends' Bring access in your project: anyone who gets into your
Supabase account could reach their lists. Share it only with people who trust you with that,
and keep two-factor authentication on for Supabase. Never change `ENCRYPTION_KEY`: that locks
out everyone who signed up.

## Troubleshooting

- **`CERTIFICATE_VERIFY_FAILED`:** shouldn't happen, since the code uses the `certifi` certificate bundle. If it does, run `install.sh` again to update dependencies.
- **"Bring login failed":** check the email and password in the credentials file. Accounts that sign in only with Google or Apple have no Bring password. Set one in the Bring app first.
- **Connector missing in Claude Desktop:** make sure you restarted the app, then check `~/Library/Logs/Claude/mcp-server-bring.log`.

## Files

```
SKILL.md              Claude Code skill instructions
scripts/bring_core.py shared logic (login, lists, add/complete/remove)
scripts/bring_cli.py  command-line interface used by the skill
scripts/bring_mcp.py  MCP server used by Claude Desktop
install.sh            setup script
remote/cloudflare/    Cloudflare Worker with OAuth for phone and claude.ai (always on)
remote/supabase/      Supabase Edge Function alternative; bring.ts and protocol.ts are shared
docs/signup.html      sign-up page for friends (GitHub Pages)
```

## License

MIT
