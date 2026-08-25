from __future__ import annotations

import asyncio
from typing import Any

import pytest

from providers.archives import (
    ARCHIVE_LIST_CACHE_TTL,
    ARCHIVE_RESPONSE_MAX_BYTES,
    ARCHIVE_STATS_MAX_BYTES,
    HISTORICAL_FETCH_CONCURRENCY,
    HISTORY_ORIGIN,
    MAX_HISTORICAL_DATES,
    MAX_HISTORICAL_MESSAGES,
    MAX_OVERSIZED_ARCHIVE_DATES,
    TRUSTED_ARCHIVE_ORIGINS,
    RecentMessagesProvider,
    ZonianHistoricalProvider,
    _sample_evenly,
)
from providers.emotes import BetterTtvProvider, FrankerFaceZProvider, SevenTvProvider
from providers.protocols import (
    ArchiveProviderUnavailableError,
    ArchiveTooLargeError,
    ArchiveYearUnavailableError,
    HistoricalArchiveNotFoundError,
    HttpResponseTooLargeError,
)


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
        accepted_statuses: tuple[int, ...] = (),
    ) -> Any | None:
        self.calls.append(
            {
                "url": url,
                "timeout_ms": timeout_ms,
                "max_bytes": max_bytes,
                "user_agent": user_agent,
                "cache_ttl": cache_ttl,
                "accepted_statuses": accepted_statuses,
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
    stats_url = (
        "https://logs.zonian.dev/channel/channel/stats"
        "?from=2024-01-02T00%3A00%3A00Z&to=2024-01-02T23%3A59%3A59.999999Z"
    )
    day_url = "https://logs.zonian.dev/channel/channel/2024/01/2?jsonBasic=1&limit=4000&offset=0"
    client = FakeHttpClient(
        {
            f"{HISTORY_ORIGIN}/api/channel": {"channelLogs": {"instances": [HISTORY_ORIGIN]}},
            list_url: {"availableLogs": [{"year": "2024", "month": "01", "day": "2"}]},
            stats_url: {"messageCount": 2},
            day_url: {"messages": [historical_message(), {"malformed": True}]},
        }
    )
    messages = await ZonianHistoricalProvider(client).fetch("channel", 0, 30)
    assert [message.id for message in messages] == ["h1"]
    list_call = next(call for call in client.calls if "/list?" in call["url"])
    stats_call = next(call for call in client.calls if "/stats?" in call["url"])
    day_call = next(call for call in client.calls if "?jsonBasic=1" in call["url"])
    assert list_call["cache_ttl"] == ARCHIVE_LIST_CACHE_TTL
    assert stats_call["max_bytes"] == ARCHIVE_STATS_MAX_BYTES
    assert day_call["cache_ttl"] == 86_400
    assert day_call["max_bytes"] == ARCHIVE_RESPONSE_MAX_BYTES


@pytest.mark.asyncio
async def test_zonian_provider_samples_stable_spread_windows_from_a_busy_day() -> None:
    list_url = "https://logs.zonian.dev/list?channel=channel"
    stats_url = (
        "https://logs.zonian.dev/channel/channel/stats"
        "?from=2025-01-27T00%3A00%3A00Z&to=2025-01-27T23%3A59%3A59.999999Z"
    )
    early_url = (
        "https://logs.zonian.dev/channel/channel/2025/01/27?jsonBasic=1&limit=2000&offset=1500"
    )
    late_url = (
        "https://logs.zonian.dev/channel/channel/2025/01/27?jsonBasic=1&limit=2000&offset=6500"
    )
    client = FakeHttpClient(
        {
            f"{HISTORY_ORIGIN}/api/channel": {"channelLogs": {"instances": [HISTORY_ORIGIN]}},
            list_url: {"availableLogs": [{"year": "2025", "month": "01", "day": "27"}]},
            stats_url: {"messageCount": 10_000},
            early_url: {"messages": [historical_message("early", "2025-01-27T06:00:00Z")]},
            late_url: {"messages": [historical_message("late", "2025-01-27T18:00:00Z")]},
        }
    )

    provider = ZonianHistoricalProvider(client)
    messages = await provider.fetch("channel", 0, None, 2025)
    repeated = await provider.fetch("channel", 0, None, 2025)

    assert [message.id for message in messages] == ["early", "late"]
    assert [message.id for message in repeated] == ["early", "late"]
    day_calls = [call["url"] for call in client.calls if "?jsonBasic=1" in call["url"]]
    assert day_calls == [early_url, late_url, early_url, late_url]


@pytest.mark.asyncio
async def test_zonian_provider_expansion_uses_different_bounded_windows() -> None:
    list_url = "https://logs.zonian.dev/list?channel=channel"
    stats_url = (
        "https://logs.zonian.dev/channel/channel/stats"
        "?from=2025-01-27T00%3A00%3A00Z&to=2025-01-27T23%3A59%3A59.999999Z"
    )
    offsets = (11_500, 36_500, 61_500, 86_500)
    urls = [
        f"https://logs.zonian.dev/channel/channel/2025/01/27?jsonBasic=1&limit=2000&offset={offset}"
        for offset in offsets
    ]
    client = FakeHttpClient(
        {
            f"{HISTORY_ORIGIN}/api/channel": {"channelLogs": {"instances": [HISTORY_ORIGIN]}},
            list_url: {"availableLogs": [{"year": "2025", "month": "01", "day": "27"}]},
            stats_url: {"messageCount": 100_000},
            **{
                url: {"messages": [historical_message(f"expanded-{index}", "2025-01-27T12:00:00Z")]}
                for index, url in enumerate(urls)
            },
        }
    )

    messages = await ZonianHistoricalProvider(client).fetch(
        "channel", 0, None, 2025, sampling_pass=2
    )

    assert [message.id for message in messages] == [f"expanded-{index}" for index in range(4)]
    assert [call["url"] for call in client.calls if "?jsonBasic=1" in call["url"]] == urls


@pytest.mark.asyncio
async def test_zonian_provider_selects_active_days_within_chronological_buckets() -> None:
    dates = [{"year": "2025", "month": "01", "day": str(day)} for day in range(1, 13)]
    responses: dict[str, Any] = {
        f"{HISTORY_ORIGIN}/api/channel": {"channelLogs": {"instances": [HISTORY_ORIGIN]}},
        f"{HISTORY_ORIGIN}/list?channel=channel": {"availableLogs": dates},
    }
    busy_days = {2, 5, 8, 11}
    for day in range(1, 13):
        stats_url = (
            f"{HISTORY_ORIGIN}/channel/channel/stats"
            f"?from=2025-01-{day:02d}T00%3A00%3A00Z"
            f"&to=2025-01-{day:02d}T23%3A59%3A59.999999Z"
        )
        responses[stats_url] = {"messageCount": 500 if day in busy_days else 5}
        if day in busy_days:
            responses[
                f"{HISTORY_ORIGIN}/channel/channel/2025/01/{day}?jsonBasic=1&limit=4000&offset=0"
            ] = {"messages": [historical_message(f"day-{day}", f"2025-01-{day:02d}T12:00:00Z")]}

    client = FakeHttpClient(responses)
    messages = await ZonianHistoricalProvider(client).fetch("channel", 0, 30, 2025)

    assert [message.id for message in messages] == [f"day-{day}" for day in sorted(busy_days)]


@pytest.mark.asyncio
async def test_discovered_instances_are_unioned_for_calendar_years() -> None:
    discovery_url = "https://logs.zonian.dev/api/channel"
    logxx_list = "https://logxx.dev/list?channel=channel"
    spanix_list = "https://logs.spanix.team/list?channel=channel"
    spanix_day = (
        "https://logs.spanix.team/channel/channel/2024/09/11?jsonBasic=1&limit=4000&offset=0"
    )
    client = FakeHttpClient(
        {
            discovery_url: {
                "channelLogs": {
                    "instances": [
                        "https://logxx.dev",
                        "https://untrusted.example",
                        "https://logs.spanix.team",
                    ]
                }
            },
            logxx_list: {"availableLogs": [{"year": "2025", "month": "06", "day": "14"}]},
            spanix_list: {"availableLogs": [{"year": "2024", "month": "09", "day": "11"}]},
            spanix_day: {
                "messages": [historical_message("spanix-2024", "2024-09-11T18:40:03.907Z")]
            },
        }
    )

    messages = await ZonianHistoricalProvider(client).fetch("channel", 0, None, 2024)

    assert [message.id for message in messages] == ["spanix-2024"]
    assert "https://logs.spanix.team" in TRUSTED_ARCHIVE_ORIGINS
    assert any(call["url"] == spanix_list for call in client.calls)
    assert any(call["url"] == spanix_day for call in client.calls)
    assert not any("untrusted.example" in call["url"] for call in client.calls)
    assert not any("/2025/" in call["url"] for call in client.calls)


@pytest.mark.asyncio
async def test_unavailable_year_stops_before_archive_downloads() -> None:
    client = FakeHttpClient(
        {
            "https://logs.zonian.dev/api/channel": {
                "channelLogs": {"instances": ["https://logs.spanix.team"]}
            },
            "https://logs.spanix.team/list?channel=channel": {
                "availableLogs": [{"year": "2024", "month": "09", "day": "11"}]
            },
        }
    )

    with pytest.raises(ArchiveYearUnavailableError, match="2023"):
        await ZonianHistoricalProvider(client).fetch("channel", 0, None, 2023)

    assert not any("/channel/" in call["url"] for call in client.calls)


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
        accepted_statuses: tuple[int, ...] = (),
    ) -> Any | None:
        if "?jsonBasic=1" not in url:
            return await super().get_json(
                url,
                timeout_ms=timeout_ms,
                max_bytes=max_bytes,
                user_agent=user_agent,
                cache_ttl=cache_ttl,
                accepted_statuses=accepted_statuses,
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
                accepted_statuses=accepted_statuses,
            )
        finally:
            self.active_archive_requests -= 1


class OversizedArchiveHttpClient(FakeHttpClient):
    async def get_json(
        self,
        url: str,
        *,
        timeout_ms: int,
        max_bytes: int,
        user_agent: str,
        cache_ttl: int | None = None,
        accepted_statuses: tuple[int, ...] = (),
    ) -> Any | None:
        if "?jsonBasic=1" in url:
            self.calls.append(
                {
                    "url": url,
                    "timeout_ms": timeout_ms,
                    "max_bytes": max_bytes,
                    "user_agent": user_agent,
                    "cache_ttl": cache_ttl,
                }
            )
            raise HttpResponseTooLargeError(max_bytes)
        return await super().get_json(
            url,
            timeout_ms=timeout_ms,
            max_bytes=max_bytes,
            user_agent=user_agent,
            cache_ttl=cache_ttl,
            accepted_statuses=accepted_statuses,
        )


@pytest.mark.asyncio
async def test_long_range_spans_history_with_bounded_concurrency() -> None:
    list_url = "https://logs.zonian.dev/list?channel=channel"
    dates = [
        {"year": str(year), "month": f"{month:02d}", "day": "1"}
        for year in (2023, 2024)
        for month in range(1, 13)
    ]
    responses: dict[str, Any] = {
        f"{HISTORY_ORIGIN}/api/channel": {"channelLogs": {"instances": [HISTORY_ORIGIN]}},
        list_url: {"availableLogs": dates},
    }
    for date in dates:
        url = (
            f"https://logs.zonian.dev/channel/channel/{date['year']}/{date['month']}/1"
            "?jsonBasic=1&limit=2000&offset=0"
        )
        responses[url] = {"messages": [historical_message(f"{date['year']}-{date['month']}")]}

    client = TrackingHttpClient(responses)
    messages = await ZonianHistoricalProvider(client).fetch("channel", 0, 1_095)

    day_calls = [call for call in client.calls if "?jsonBasic=1" in call["url"]]
    assert len(day_calls) == MAX_HISTORICAL_DATES
    assert client.maximum_archive_requests == HISTORICAL_FETCH_CONCURRENCY
    assert any("/2023/" in call["url"] for call in day_calls)
    assert any("/2024/" in call["url"] for call in day_calls)
    assert len(messages) == MAX_HISTORICAL_DATES


@pytest.mark.asyncio
async def test_oversized_dates_do_not_retry_mirrors_or_exhaust_the_request() -> None:
    origins = ("https://logxx.dev", "https://logs.spanix.team")
    dates = [
        {"year": "2025", "month": f"{month:02d}", "day": "15"}
        for month in range(1, MAX_HISTORICAL_DATES + 1)
    ]
    responses: dict[str, Any] = {
        "https://logs.zonian.dev/api/channel": {"channelLogs": {"instances": list(origins)}},
        **{f"{origin}/list?channel=channel": {"availableLogs": dates} for origin in origins},
    }
    client = OversizedArchiveHttpClient(responses)
    provider = ZonianHistoricalProvider(client)

    with pytest.raises(ArchiveTooLargeError, match="2025 archive"):
        await provider.fetch("channel", 0, None, 2025)

    day_calls = [call for call in client.calls if "?jsonBasic=1" in call["url"]]
    assert len(day_calls) == MAX_OVERSIZED_ARCHIVE_DATES
    assert all(call["url"].startswith(origins[0]) for call in day_calls)


@pytest.mark.asyncio
async def test_historical_messages_have_a_hard_global_budget() -> None:
    list_url = "https://logs.zonian.dev/list?channel=channel"
    dates = [
        {"year": "2024", "month": f"{month:02d}", "day": "1"}
        for month in range(1, MAX_HISTORICAL_DATES + 1)
    ]
    responses: dict[str, Any] = {
        f"{HISTORY_ORIGIN}/api/channel": {"channelLogs": {"instances": [HISTORY_ORIGIN]}},
        list_url: {"availableLogs": dates},
    }
    messages_per_date = MAX_HISTORICAL_MESSAGES // MAX_HISTORICAL_DATES + 200
    for date in dates:
        url = (
            f"https://logs.zonian.dev/channel/channel/2024/{date['month']}/1"
            "?jsonBasic=1&limit=2000&offset=0"
        )
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
async def test_discovery_distinguishes_missing_archive_from_provider_failure() -> None:
    missing = FakeHttpClient(
        {
            f"{HISTORY_ORIGIN}/api/channel": {
                "status": 404,
                "available": {"channel": False},
                "channelLogs": {"instances": []},
            }
        }
    )
    with pytest.raises(HistoricalArchiveNotFoundError):
        await ZonianHistoricalProvider(missing).fetch("channel", 0, 90)

    failing = FakeHttpClient({})
    with pytest.raises(ArchiveProviderUnavailableError):
        await ZonianHistoricalProvider(failing).fetch("channel", 0, 90)


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
