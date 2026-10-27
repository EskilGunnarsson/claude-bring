#!/usr/bin/env python3
"""MCP server exposing Bring! shopping lists to Claude Desktop (stdio transport)."""

from __future__ import annotations

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel, Field

import bring_core as core

mcp = MCPServer(
    "bring",
    instructions=(
        "Manage the user's Bring! shopping lists. Item names are shown in the list's "
        "language (e.g. German 'Milch'); use the same language when adding or "
        "completing items. When no list is given, the account's default list is used."
    ),
)


class Item(BaseModel):
    name: str = Field(description="Item name, e.g. 'Milk'")
    spec: str = Field("", description="Optional quantity or note, e.g. '2 l' or 'lactose free'")


async def _call(fn, *args):
    try:
        async with core.bring_client() as bring:
            return await fn(bring, *args)
    except core.BringError as err:
        raise ToolError(str(err)) from err


@mcp.tool()
async def bring_get_lists() -> dict:
    """List all Bring! shopping lists on the account."""
    async def fn(bring):
        return {"lists": await core.get_lists(bring)}
    return await _call(fn)


@mcp.tool()
async def bring_show_list(list_name: str | None = None, include_recent: bool = False) -> dict:
    """Show the items to buy on a shopping list (default list if list_name is omitted).

    Set include_recent to also return recently bought items.
    """
    return await _call(core.show, list_name, include_recent)


@mcp.tool()
async def bring_add_items(items: list[Item], list_name: str | None = None) -> dict:
    """Add one or more items to a shopping list. Items already on the list without a
    new spec are skipped. Giving a spec for an item already on the list updates it."""
    return await _call(core.add, list_name, [(i.name.strip(), i.spec.strip()) for i in items])


@mcp.tool()
async def bring_complete_items(names: list[str], list_name: str | None = None) -> dict:
    """Mark items as bought (moves them to recently bought). Names match case-insensitively."""
    return await _call(core.complete, list_name, names)


@mcp.tool()
async def bring_remove_items(names: list[str], list_name: str | None = None) -> dict:
    """Remove items from a list without marking them bought. Names match case-insensitively."""
    return await _call(core.remove, list_name, names)


if __name__ == "__main__":
    mcp.run()
