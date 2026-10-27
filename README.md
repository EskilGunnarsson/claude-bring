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
```

## License

MIT
