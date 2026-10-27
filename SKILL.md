---
name: bring
description: Manage the user's Bring! shopping lists — show what's on a list, add items (with quantities/notes), mark items as bought, or remove them. Use when the user mentions Bring, their shopping list, grocery list, or asks to add/buy/check off groceries.
---

# Bring! shopping lists

Run the CLI with the skill's own Python environment:

```bash
~/.claude/skills/bring/.venv/bin/python ~/.claude/skills/bring/scripts/bring_cli.py <command> [options]
```

## Commands

| Command | What it does |
|---|---|
| `lists` | Show all lists on the account |
| `show [--recent]` | Show items to buy (`--recent` adds recently bought) |
| `add ITEM...` | Add items. Use `Name:spec` for a quantity or note, e.g. `"Milk:2 l"` |
| `complete ITEM...` | Mark items as bought |
| `remove ITEM...` | Remove items without marking them bought |

Options: `--list NAME` picks a list (default: the account's default list, or `BRING_LIST`), `--dry-run` previews `add`/`complete`/`remove` without changing anything, and `--json` (before the command) gives JSON output.

## Notes

- Item names come back in the list's language (e.g. German "Milch"). Use that language when adding or completing, so items match Bring's catalog and icons.
- `complete` and `remove` match names case-insensitively against what's on the list and report any that weren't found. Run `show` first if unsure of the exact name.
- Adding an item that's already on the list without a spec is skipped. With a spec, it updates the spec.
- Credentials come from `BRING_EMAIL` / `BRING_PASSWORD` or `~/.config/bring-skill/credentials`. Never ask the user for their password in chat or pass it as an argument. If they're missing, tell the user to create that file themselves.
- The same logic is exposed to Claude Desktop as the `bring` MCP server (`scripts/bring_mcp.py`).
