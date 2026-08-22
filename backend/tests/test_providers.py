from __future__ import annotations

import asyncio
from typing import Any

import pytest

from providers.archives import (
    ARCHIVE_LIST_CACHE_TTL,
    ARCHIVE_RESPONSE_MAX_BYTES,
    HISTORICAL_FETCH_CONCURRENCY,
    MAX_HISTORICAL_DATES,
    MAX_HISTORICAL_MESSAGES,
    RecentMessagesProvider,
    ZonianHistoricalProvider,
    _sample_evenly,
)
from providers.emotes import BetterTtvProvider, FrankerFaceZProvider, SevenTvProvider


class FakeHttpClient:
    def __init__(self, responses: dict[str, Any]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def get_json(
        self,
        url: str,
        *,
        timeout_ms: int,
        max_bytes: int,
        user_agent: str,
        cache_ttl: int | None = None,
    ) -> Any | None:
        self.calls.append(
            {
                "url": url,
                "timeout_ms": timeout_ms,
                "max_bytes": max_bytes,
                "user_agent": user_agent,
                "cache_ttl": cache_ttl,
            }
        )
        return self.responses.get(url)


def historical_message(
    identifier: str = "h1", timestamp: str = "2024-01-02T03:04:05.000Z"
) -> dict[str, Any]:
    return {
        "id": identifier,
        "text": "This historical sentence is distinctive enough, right?",
        "displayName": "Alice",
        "timestamp": timestamp,
        "tags": {"user-id": "u1", "room-id": "99", "emotes": ""},
    }


@pytest.mark.asyncio
async def test_zonian_provider_samples_and_caches_completed_day() -> None:
    list_url = "https://logs.zonian.dev/list?channel=channel"
    day_url = "https://logs.zonian.dev/channel/channel/2024/01/2?jsonBasic=1"
    client = FakeHttpClient(
        {
            list_url: {"availableLogs": [{"year": "2024", "month": "01", "day": "2"}]},
            day_url: {"messages": [historical_message(), {"malformed": True}]},
        }
    )
    messages = await ZonianHistoricalProvider(client).fetch("channel", 0, 30)
    assert [message.id for message in messages] == ["h1"]
    list_call = next(call for call in client.calls if "/list?" in call["url"])
    day_call = next(call for call in client.calls if "/channel/" in call["url"])
    assert list_call["cache_ttl"] == ARCHIVE_LIST_CACHE_TTL
    assert day_call["cache_ttl"] == 86_400
    assert day_call["max_bytes"] == ARCHIVE_RESPONSE_MAX_BYTES


class TrackingHttpClient(FakeHttpClient):
    def __init__(self, responses: dict[str, Any]) -> None:
        super().__init__(responses)
        self.active_archive_requests = 0
        self.maximum_archive_requests = 0

    async def get_json(
        self,
        url: str,
        *,
        timeout_ms: int,
        max_bytes: int,
        user_agent: str,
        cache_ttl: int | None = None,
    ) -> Any | None:
        if "/channel/" not in url:
            return await super().get_json(
                url,
                timeout_ms=timeout_ms,
                max_bytes=max_bytes,
                user_agent=user_agent,
                cache_ttl=cache_ttl,
            )
        self.active_archive_requests += 1
        self.maximum_archive_requests = max(
            self.maximum_archive_requests, self.active_archive_requests
        )
        try:
            await asyncio.sleep(0)
            return await super().get_json(
                url,
                timeout_ms=timeout_ms,
                max_bytes=max_bytes,
                user_agent=user_agent,
                cache_ttl=cache_ttl,
            )
        finally:
            self.active_archive_requests -= 1


@pytest.mark.asyncio
async def test_long_range_spans_history_with_bounded_concurrency() -> None:
    list_url = "https://logs.zonian.dev/list?channel=channel"
    dates = [
        {"year": str(year), "month": f"{month:02d}", "day": "1"}
        for year in (2023, 2024)
        for month in range(1, 13)
    ]
    responses: dict[str, Any] = {list_url: {"availableLogs": dates}}
    for date in dates:
        url = (
            f"https://logs.zonian.dev/channel/channel/{date['year']}/{date['month']}/1?jsonBasic=1"
        )
        responses[url] = {"messages": [historical_message(f"{date['year']}-{date['month']}")]}

    client = TrackingHttpClient(responses)
    messages = await ZonianHistoricalProvider(client).fetch("channel", 0, 1_095)

    day_calls = [call for call in client.calls if "/channel/" in call["url"]]
    assert len(day_calls) == MAX_HISTORICAL_DATES
    assert client.maximum_archive_requests == HISTORICAL_FETCH_CONCURRENCY
    assert any("/2023/" in call["url"] for call in day_calls)
    assert any("/2024/" in call["url"] for call in day_calls)
    assert len(messages) == MAX_HISTORICAL_DATES


@pytest.mark.asyncio
async def test_historical_messages_have_a_hard_global_budget() -> None:
    list_url = "https://logs.zonian.dev/list?channel=channel"
    dates = [
        {"year": "2024", "month": f"{month:02d}", "day": "1"}
        for month in range(1, MAX_HISTORICAL_DATES + 1)
    ]
    responses: dict[str, Any] = {list_url: {"availableLogs": dates}}
    messages_per_date = MAX_HISTORICAL_MESSAGES // MAX_HISTORICAL_DATES + 200
    for date in dates:
        url = f"https://logs.zonian.dev/channel/channel/2024/{date['month']}/1?jsonBasic=1"
        responses[url] = {
            "messages": [
                historical_message(f"{date['month']}-{index}") for index in range(messages_per_date)
            ]
        }

    messages = await ZonianHistoricalProvider(FakeHttpClient(responses)).fetch("channel", 0, 1_095)

    assert len(messages) == MAX_HISTORICAL_MESSAGES


def test_representative_sampling_uses_the_whole_sequence() -> None:
    assert _sample_evenly(list(range(100)), 4) == [12, 37, 62, 87]


@pytest.mark.asyncio
async def test_recent_provider_keeps_only_irc_strings() -> None:
    url = "https://example.test/channel?limit=1000"
    client = FakeHttpClient({url: {"messages": ["irc", 7, None]}})
    messages = await RecentMessagesProvider(client, "https://example.test/").fetch("channel", 1000)
    assert messages == ["irc"]
    assert client.calls[0]["cache_ttl"] is None


@pytest.mark.asyncio
async def test_emote_providers_parse_catalogs_and_use_cache() -> None:
    responses = {
        "https://api.7tv.app/v3/users/twitch/99": {
            "emote_set": {
                "emotes": [{"name": "Seven", "data": {"host": {"url": "//cdn.7tv.test/id"}}}]
            }
        },
        "https://7tv.io/v3/users/twitch/99": None,
        "https://api.betterttv.net/3/cached/users/twitch/99": {
            "channelEmotes": [{"code": "Better", "id": "b1"}],
            "sharedEmotes": [],
        },
        "https://api.betterttv.net/3/cached/emotes/global": [],
        "https://api.frankerfacez.com/v1/room/id/99": {
            "sets": {
                "1": {"emoticons": [{"name": "Franker", "id": 1, "urls": {"4": "//ffz.test/e"}}]}
            }
        },
        "https://api.frankerfacez.com/v1/set/global": {"sets": {}},
    }
    client = FakeHttpClient(responses)
    seven = await SevenTvProvider(client).fetch("99")
    better = await BetterTtvProvider(client).fetch("99")
    franker = await FrankerFaceZProvider(client).fetch("99")
    assert seven == {"Seven": "https://cdn.7tv.test/id/4x.webp"}
    assert better == {"Better": "https://cdn.betterttv.net/emote/b1/3x"}
    assert franker == {"Franker": "https://ffz.test/e"}
    assert all(call["cache_ttl"] == 3_600 for call in client.calls)
