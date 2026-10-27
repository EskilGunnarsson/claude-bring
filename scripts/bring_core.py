"""Shared Bring! logic for the CLI (Claude Code skill) and the MCP server (Claude Desktop).

Credentials come from BRING_EMAIL / BRING_PASSWORD in the environment, or from
~/.config/bring-skill/credentials (KEY=value lines).
"""

from __future__ import annotations

import os
import ssl
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import aiohttp
import certifi
from bring_api import Bring, BringItemOperation
from bring_api.exceptions import BringAuthException, BringException

CREDENTIALS_FILE = Path.home() / ".config" / "bring-skill" / "credentials"


class BringError(Exception):
    """A user-facing error with a readable message."""


def load_credentials() -> tuple[str, str]:
    values = {}
    if CREDENTIALS_FILE.exists():
        for line in CREDENTIALS_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    email = os.environ.get("BRING_EMAIL") or values.get("BRING_EMAIL")
    password = os.environ.get("BRING_PASSWORD") or values.get("BRING_PASSWORD")
    if not email or not password:
        raise BringError(
            "Missing Bring credentials. Set BRING_EMAIL and BRING_PASSWORD, "
            f"or put them in {CREDENTIALS_FILE}."
        )
    return email, password


@asynccontextmanager
async def bring_client() -> AsyncIterator[Bring]:
    email, password = load_credentials()
    # python.org builds of Python on macOS ship without CA certificates, so use certifi's.
    connector = aiohttp.TCPConnector(ssl=ssl.create_default_context(cafile=certifi.where()))
    async with aiohttp.ClientSession(connector=connector) as session:
        bring = Bring(session, email, password)
        try:
            await bring.login()
            yield bring
        except BringAuthException as err:
            raise BringError("Bring login failed. Check BRING_EMAIL / BRING_PASSWORD.") from err
        except BringException as err:
            raise BringError(f"Bring request failed: {err}") from err


def parse_item(raw: str) -> tuple[str, str]:
    """'Milk:2 l' -> ('Milk', '2 l'); 'Milk' -> ('Milk', '')."""
    name, _, spec = raw.partition(":")
    return name.strip(), spec.strip()


def _purchase(p) -> dict:
    return {"name": p.itemId, "spec": p.specification}


async def get_lists(bring: Bring) -> list[dict]:
    return [{"name": l.name, "uuid": l.listUuid} for l in (await bring.load_lists()).lists]


async def resolve_list(bring: Bring, wanted: str | None) -> tuple[str, str]:
    """Pick a list by name/UUID, else BRING_LIST, else the account's default list."""
    lists = (await bring.load_lists()).lists
    if not lists:
        raise BringError("This Bring account has no lists.")
    wanted = wanted or os.environ.get("BRING_LIST")
    if wanted:
        for lst in lists:
            if wanted.lower() in (lst.name.lower(), lst.listUuid.lower()):
                return lst.listUuid, lst.name
        names = ", ".join(lst.name for lst in lists)
        raise BringError(f"No list named '{wanted}'. Available lists: {names}")
    settings = await bring.get_all_user_settings()
    default_uuid = next(
        (s.value for s in settings.usersettings if s.key == "defaultListUUID"), None
    )
    for lst in lists:
        if lst.listUuid == default_uuid:
            return lst.listUuid, lst.name
    return lists[0].listUuid, lists[0].name


async def show(bring: Bring, list_name: str | None, recent: bool = False) -> dict:
    list_uuid, name = await resolve_list(bring, list_name)
    items = (await bring.get_list(list_uuid)).items
    result = {"list": name, "to_buy": [_purchase(p) for p in items.purchase]}
    if recent:
        result["recent"] = [_purchase(p) for p in items.recently]
    return result


async def add(
    bring: Bring, list_name: str | None, items: list[tuple[str, str]], dry_run: bool = False
) -> dict:
    list_uuid, name = await resolve_list(bring, list_name)
    on_list = {p.itemId.lower() for p in (await bring.get_list(list_uuid)).items.purchase}
    changes, skipped = [], []
    for item_name, spec in items:
        if not item_name:
            continue
        # Re-adding an item that's already there only makes sense to change its spec.
        if item_name.lower() in on_list and not spec:
            skipped.append(item_name)
            continue
        changes.append({"itemId": item_name, "spec": spec, "uuid": None})
    if changes and not dry_run:
        await bring.batch_update_list(list_uuid, changes, BringItemOperation.ADD)
    return {
        "list": name,
        "dry_run": dry_run,
        "added": [{"name": c["itemId"], "spec": c["spec"]} for c in changes],
        "already_on_list": skipped,
    }


async def _change(
    bring: Bring,
    list_name: str | None,
    names: list[str],
    operation: BringItemOperation,
    done_key: str,
    dry_run: bool,
) -> dict:
    list_uuid, name = await resolve_list(bring, list_name)
    by_name = {p.itemId.lower(): p for p in (await bring.get_list(list_uuid)).items.purchase}
    changes, missing = [], []
    for item_name in names:
        match = by_name.get(item_name.strip().lower())
        if match is None:
            missing.append(item_name)
            continue
        changes.append({"itemId": match.itemId, "spec": match.specification, "uuid": match.uuid})
    if changes and not dry_run:
        await bring.batch_update_list(list_uuid, changes, operation)
    return {
        "list": name,
        "dry_run": dry_run,
        done_key: [c["itemId"] for c in changes],
        "not_on_list": missing,
    }


async def complete(bring: Bring, list_name: str | None, names: list[str], dry_run: bool = False) -> dict:
    return await _change(bring, list_name, names, BringItemOperation.COMPLETE, "completed", dry_run)


async def remove(bring: Bring, list_name: str | None, names: list[str], dry_run: bool = False) -> dict:
    return await _change(bring, list_name, names, BringItemOperation.REMOVE, "removed", dry_run)
