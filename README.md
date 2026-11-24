# Bring! for Claude

Let Claude manage your [Bring!](https://www.getbring.com) shopping lists: see what's on a list, add items with quantities or notes, mark items as bought, and remove them.

It works in two places:

- **Claude desktop app (regular chat):** as a local MCP connector called `bring`.
- **Claude Code:** as a skill, so you can say "add oat milk to the Bring list" in a coding session.

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

## Phone and claude.ai (remote connector)

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
remote/               Supabase Edge Function for phone and claude.ai (TypeScript)
docs/signup.html      sign-up page for friends (GitHub Pages)
```

## License

MIT
