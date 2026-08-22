from __future__ import annotations

import asyncio
from typing import Any, Literal, cast

from providers.protocols import JsonHttpClient


def _dictionary(value: Any) -> dict[str, Any]:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else {}


def _add_entries(
    catalog: dict[str, str], entries: Any, provider: Literal["7tv", "bttv", "ffz"]
) -> None:
    if not isinstance(entries, list):
        return
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        raw_name = entry.get("name", entry.get("code"))
        name = raw_name if isinstance(raw_name, str) else ""
        raw_id = entry.get("id")
        emote_id = str(raw_id) if isinstance(raw_id, (str, int)) else ""
        url = ""
        if provider == "7tv":
            data = _dictionary(entry.get("data"))
            host = _dictionary(data.get("host"))
            candidate = host.get("url")
            if isinstance(candidate, str):
                url = f"{'https:' if candidate.startswith('//') else ''}{candidate}/4x.webp"
        elif provider == "bttv" and emote_id:
            url = f"https://cdn.betterttv.net/emote/{emote_id}/3x"
        else:
            urls = _dictionary(entry.get("urls"))
            candidate = urls.get("4", urls.get("2", urls.get("1")))
            if isinstance(candidate, str):
                url = f"{'https:' if candidate.startswith('//') else ''}{candidate}"
        if name and url and name not in catalog:
            catalog[name] = url


class SevenTvProvider:
    def __init__(self, client: JsonHttpClient) -> None:
        self._client = client

    async def fetch(self, room_id: str) -> dict[str, str]:
        payloads = await asyncio.gather(
            self._get(f"https://api.7tv.app/v3/users/twitch/{room_id}"),
            self._get(f"https://7tv.io/v3/users/twitch/{room_id}"),
            return_exceptions=True,
        )
        catalog: dict[str, str] = {}
        for payload in payloads:
            if not isinstance(payload, dict):
                continue
            emote_set = _dictionary(payload.get("emote_set"))
            _add_entries(catalog, emote_set.get("emotes"), "7tv")
        return catalog

    async def _get(self, url: str) -> Any | None:
        return await self._client.get_json(
            url,
            timeout_ms=5_000,
            max_bytes=5_000_000,
            user_agent="KnowTheChat/1.0",
            cache_ttl=3_600,
        )


class BetterTtvProvider:
    def __init__(self, client: JsonHttpClient) -> None:
        self._client = client

    async def fetch(self, room_id: str) -> dict[str, str]:
        channel, global_emotes = await asyncio.gather(
            self._get(f"https://api.betterttv.net/3/cached/users/twitch/{room_id}"),
            self._get("https://api.betterttv.net/3/cached/emotes/global"),
            return_exceptions=True,
        )
        catalog: dict[str, str] = {}
        if isinstance(channel, dict):
            _add_entries(catalog, channel.get("channelEmotes"), "bttv")
            _add_entries(catalog, channel.get("sharedEmotes"), "bttv")
        if isinstance(global_emotes, list):
            _add_entries(catalog, global_emotes, "bttv")
        return catalog

    async def _get(self, url: str) -> Any | None:
        return await self._client.get_json(
            url,
            timeout_ms=5_000,
            max_bytes=5_000_000,
            user_agent="KnowTheChat/1.0",
            cache_ttl=3_600,
        )


class FrankerFaceZProvider:
    def __init__(self, client: JsonHttpClient) -> None:
        self._client = client

    async def fetch(self, room_id: str) -> dict[str, str]:
        payloads = await asyncio.gather(
            self._get(f"https://api.frankerfacez.com/v1/room/id/{room_id}"),
            self._get("https://api.frankerfacez.com/v1/set/global"),
            return_exceptions=True,
        )
        catalog: dict[str, str] = {}
        for payload in payloads:
            if not isinstance(payload, dict):
                continue
            sets = _dictionary(payload.get("sets"))
            for value in sets.values():
                if isinstance(value, dict):
                    _add_entries(catalog, value.get("emoticons"), "ffz")
        return catalog

    async def _get(self, url: str) -> Any | None:
        return await self._client.get_json(
            url,
            timeout_ms=5_000,
            max_bytes=5_000_000,
            user_agent="KnowTheChat/1.0",
            cache_ttl=3_600,
        )
