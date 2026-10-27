#!/usr/bin/env bash
# Installs the Bring! connector: a Python environment, a credentials template,
# the Claude Code skill, and (on macOS) the Claude Desktop MCP server entry.
# Usage: ./install.sh [--no-desktop]
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${PYTHON:-python3}"
REGISTER_DESKTOP=1
[ "${1:-}" = "--no-desktop" ] && REGISTER_DESKTOP=0

if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  echo "Python 3.10 or newer is required (set PYTHON=/path/to/python3 to choose one)." >&2
  exit 1
fi

echo "==> Creating Python environment in $DIR/.venv"
"$PYTHON" -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install --quiet --disable-pip-version-check -r "$DIR/requirements.txt"

CRED_DIR="$HOME/.config/bring-skill"
CRED_FILE="$CRED_DIR/credentials"
if [ ! -e "$CRED_FILE" ]; then
  echo "==> Creating credentials template at $CRED_FILE"
  mkdir -p "$CRED_DIR" && chmod 700 "$CRED_DIR"
  printf '# Bring! login used by the Bring skill and Claude Desktop connector\nBRING_EMAIL=\nBRING_PASSWORD=\n' > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
else
  echo "==> Keeping existing credentials at $CRED_FILE"
fi

# The skill's instructions call the CLI at ~/.claude/skills/bring.
SKILL_DIR="$HOME/.claude/skills/bring"
if [ "$DIR" != "$SKILL_DIR" ]; then
  if [ -e "$SKILL_DIR" ] || [ -L "$SKILL_DIR" ]; then
    echo "==> $SKILL_DIR already exists; leaving it alone (Claude Code skill not linked)"
  else
    echo "==> Linking Claude Code skill: $SKILL_DIR -> $DIR"
    mkdir -p "$HOME/.claude/skills"
    ln -s "$DIR" "$SKILL_DIR"
  fi
fi

DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
if [ "$REGISTER_DESKTOP" = 1 ] && [ -d "$(dirname "$DESKTOP_CONFIG")" ]; then
  echo "==> Registering the 'bring' MCP server in Claude Desktop"
  [ -f "$DESKTOP_CONFIG" ] && cp "$DESKTOP_CONFIG" "$DESKTOP_CONFIG.bak-before-bring"
  "$DIR/.venv/bin/python" - "$DESKTOP_CONFIG" "$DIR" <<'EOF'
import json, sys
from pathlib import Path
path, root = Path(sys.argv[1]), sys.argv[2]
cfg = json.loads(path.read_text()) if path.exists() and path.read_text().strip() else {}
cfg.setdefault("mcpServers", {})["bring"] = {
    "command": f"{root}/.venv/bin/python",
    "args": [f"{root}/scripts/bring_mcp.py"],
}
path.write_text(json.dumps(cfg, indent=2))
EOF
elif [ "$REGISTER_DESKTOP" = 1 ]; then
  echo "==> Claude Desktop config folder not found; skipping. Add this to claude_desktop_config.json yourself:"
  printf '  "mcpServers": { "bring": { "command": "%s", "args": ["%s"] } }\n' \
    "$DIR/.venv/bin/python" "$DIR/scripts/bring_mcp.py"
fi

cat <<EOF

Done. Next steps:
  1. Put your Bring! email and password in $CRED_FILE
  2. Restart the Claude desktop app
  3. Test it:  $DIR/.venv/bin/python $DIR/scripts/bring_cli.py lists
EOF
