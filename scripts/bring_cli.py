#!/usr/bin/env python3
"""Command-line interface for Bring! shopping lists (used by the Claude Code skill)."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

import bring_core as core


async def run(args: argparse.Namespace) -> dict:
    async with core.bring_client() as bring:
        if args.command == "lists":
            return {"lists": await core.get_lists(bring)}
        if args.command == "show":
            return await core.show(bring, args.list, args.recent)
        if args.command == "add":
            items = [core.parse_item(raw) for raw in args.items]
            return await core.add(bring, args.list, items, args.dry_run)
        names = [core.parse_item(raw)[0] for raw in args.items]
        if args.command == "complete":
            return await core.complete(bring, args.list, names, args.dry_run)
        return await core.remove(bring, args.list, names, args.dry_run)


def print_human(result: dict) -> None:
    if "lists" in result:
        for lst in result["lists"]:
            print(lst["name"])
        return
    print(f"List: {result['list']}" + ("  (dry run, nothing changed)" if result.get("dry_run") else ""))
    for key, label in [
        ("to_buy", "To buy"),
        ("recent", "Recently bought"),
        ("added", "Added"),
        ("already_on_list", "Already on list"),
        ("completed", "Marked bought"),
        ("removed", "Removed"),
        ("not_on_list", "Not on list"),
    ]:
        entries = result.get(key)
        if entries is None:
            continue
        print(f"{label} ({len(entries)}):")
        for e in entries:
            if isinstance(e, dict):
                print(f"  - {e['name']}" + (f" ({e['spec']})" if e.get("spec") else ""))
            else:
                print(f"  - {e}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage Bring! shopping lists.")
    parser.add_argument("--json", action="store_true", help="print JSON output")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("lists", help="list all shopping lists")

    def with_list(p):
        p.add_argument("--list", help="list name or UUID (default: account default list)")
        return p

    show = with_list(sub.add_parser("show", help="show items on a list"))
    show.add_argument("--recent", action="store_true", help="also show recently bought items")

    for cmd, help_text in [
        ("add", "add items; use 'Name:spec' for a quantity/note, e.g. 'Milk:2 l'"),
        ("complete", "mark items as bought"),
        ("remove", "remove items without marking them bought"),
    ]:
        p = with_list(sub.add_parser(cmd, help=help_text))
        p.add_argument("items", nargs="+")
        p.add_argument("--dry-run", action="store_true", help="show what would change")

    args = parser.parse_args()
    try:
        result = asyncio.run(run(args))
    except core.BringError as err:
        sys.exit(str(err))

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_human(result)


if __name__ == "__main__":
    main()
