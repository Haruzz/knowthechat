from __future__ import annotations

import asyncio
import random
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from domain.models import ArchiveDate, Message
from domain.parsing import parse_historical_message
from domain.sampling import date_key, sample_dates, sample_even_dates
from providers.protocols import (
    ArchiveTooLargeError,
    ArchiveYearUnavailableError,
    HttpResponseTooLargeError,
    JsonHttpClient,
)

HISTORY_ORIGIN = "https://logs.zonian.dev"
ARCHIVE_LIST_CACHE_TTL = 300
ARCHIVE_DISCOVERY_MAX_BYTES = 2_000_000
ARCHIVE_LIST_MAX_BYTES = 1_000_000
ARCHIVE_STATS_MAX_BYTES = 100_000
ARCHIVE_RESPONSE_MAX_BYTES = 10_000_000
HISTORICAL_FETCH_CONCURRENCY = 2
MAX_ARCHIVE_INSTANCES = 6
MAX_HISTORICAL_DATES = 12
MAX_HISTORICAL_MESSAGES = 6_000
MAX_HISTORICAL_MESSAGES_PER_DATE = 1_000
MAX_OVERSIZED_ARCHIVE_DATES = 2
PARSE_CANDIDATE_MULTIPLIER = 4
TRUSTED_ARCHIVE_ORIGINS = frozenset(
    {
        "https://harambelogs.pl",
        "https://logs.fais.al",
        "https://logs.folhinhabot.com",
        "https://logs.ivr.fi",
        "https://logs.jimmyboy.dev",
        "https://logs.magichack.xyz",
        "https://logs.mejkiz.com",
        "https://logs.mrchuw.com.br",
        "https://logs.nadeko.net",
        "https://logs.potat.app",
        "https://logs.spanix.team",
        "https://logs.supa.codes",
        "https://logs.susgee.dev",
        "https://logs.twitchmetrics.xyz",
        "https://logxx.dev",
        "https://vtlogs.moe",
    }
)


def _sample_evenly[T](values: Sequence[T], maximum: int) -> list[T]:
    """Choose representative values without copying the full input sequence."""
    if len(values) <= maximum:
        return list(values)
    return [values[(2 * index + 1) * len(values) // (2 * maximum)] for index in range(maximum)]


def _maximum_dates(range_days: float | None) -> int:
    if range_days is not None and range_days <= 30:
        return 4
    if range_days is not None and range_days <= 90:
        return 6
    return MAX_HISTORICAL_DATES


class ZonianHistoricalProvider:
    def __init__(
        self,
        client: JsonHttpClient,
        *,
        rng: random.Random | None = None,
    ) -> None:
        self._client = client
        self._rng = rng

    async def fetch(
        self,
        channel: str,
        cutoff_ms: float,
        range_days: float | None,
        archive_year: int | None = None,
    ) -> list[Message]:
        origins = await self._discover_origins(channel)
        list_payloads = await asyncio.gather(
            *(self._fetch_available_dates(origin, channel) for origin in origins)
        )
        locations: dict[ArchiveDate, list[str]] = {}
        successful_lists = 0
        for origin, payload in zip(origins, list_payloads, strict=True):
            raw_available = payload.get("availableLogs") if isinstance(payload, dict) else None
            if not isinstance(raw_available, list):
                continue
            successful_lists += 1
            for value in raw_available:
                date = self._parse_available_date(value, cutoff_ms, archive_year)
                if date is None:
                    continue
                date_origins = locations.setdefault(date, [])
                if origin not in date_origins:
                    date_origins.append(origin)

        if archive_year is not None and successful_lists and not locations:
            raise ArchiveYearUnavailableError(archive_year)
        if not locations:
            return []

        available = list(locations)
        maximum = _maximum_dates(range_days)
        chosen = (
            sample_even_dates(available, maximum, self._rng)
            if range_days is not None and range_days <= 90
            else sample_dates(available, maximum, self._rng)
        )
        per_date_limit = min(
            MAX_HISTORICAL_MESSAGES_PER_DATE,
            max(1, MAX_HISTORICAL_MESSAGES // len(chosen)),
        )
        messages: list[Message] = []
        oversized_dates = 0
        for start in range(0, len(chosen), HISTORICAL_FETCH_CONCURRENCY):
            dates = chosen[start : start + HISTORICAL_FETCH_CONCURRENCY]
            batches = await asyncio.gather(
                *(
                    self._fetch_date(channel, date, tuple(locations[date]), per_date_limit)
                    for date in dates
                ),
                return_exceptions=True,
            )
            for batch in batches:
                if isinstance(batch, list):
                    messages.extend(batch)
                elif isinstance(batch, HttpResponseTooLargeError):
                    oversized_dates += 1
            if oversized_dates >= MAX_OVERSIZED_ARCHIVE_DATES:
                if messages:
                    break
                raise ArchiveTooLargeError(archive_year)
        return messages[:MAX_HISTORICAL_MESSAGES]

    async def _discover_origins(self, channel: str) -> tuple[str, ...]:
        payload = await self._client.get_json(
            f"{HISTORY_ORIGIN}/api/{quote(channel)}",
            timeout_ms=12_000,
            max_bytes=ARCHIVE_DISCOVERY_MAX_BYTES,
            user_agent="KnowTheChat/1.0",
            cache_ttl=ARCHIVE_LIST_CACHE_TTL,
        )
        channel_logs = payload.get("channelLogs") if isinstance(payload, dict) else None
        raw_origins = channel_logs.get("instances") if isinstance(channel_logs, dict) else None
        origins: list[str] = []
        if isinstance(raw_origins, list):
            for value in raw_origins:
                origin = value.rstrip("/") if isinstance(value, str) else ""
                if origin in TRUSTED_ARCHIVE_ORIGINS and origin not in origins:
                    origins.append(origin)
                if len(origins) >= MAX_ARCHIVE_INSTANCES:
                    break
        return tuple(origins) if origins else (HISTORY_ORIGIN,)

    async def _fetch_available_dates(self, origin: str, channel: str) -> object:
        return await self._client.get_json(
            f"{origin}/list?channel={quote(channel)}",
            timeout_ms=12_000,
            max_bytes=ARCHIVE_LIST_MAX_BYTES,
            user_agent="KnowTheChat/1.0",
            cache_ttl=ARCHIVE_LIST_CACHE_TTL,
        )

    @staticmethod
    def _parse_available_date(
        value: object, cutoff_ms: float, archive_year: int | None
    ) -> ArchiveDate | None:
        if not isinstance(value, dict):
            return None
        year, month, day = value.get("year"), value.get("month"), value.get("day")
        if not isinstance(year, str) or not isinstance(month, str):
            return None
        if day is not None and not isinstance(day, str):
            return None
        if archive_year is not None and year != str(archive_year):
            return None
        try:
            end_of_day = (
                datetime(int(year), int(month), int(day or 1), 23, 59, 59, tzinfo=UTC).timestamp()
                * 1000
            )
        except ValueError:
            return None
        return ArchiveDate(year, month, day) if end_of_day >= cutoff_ms else None

    async def _fetch_date(
        self, channel: str, date: ArchiveDate, origins: tuple[str, ...], message_limit: int
    ) -> list[Message]:
        suffix = f"/{date.day}" if date.day else ""
        today = datetime.now(UTC).date().isoformat()
        candidate_limit = message_limit * PARSE_CANDIDATE_MULTIPLIER
        for origin in origins:
            cache_ttl = 300 if date_key(date) == today else 86_400
            message_count = await self._fetch_message_count(
                origin, channel, date, cache_ttl=cache_ttl
            )
            maximum_offset = max(0, message_count - candidate_limit)
            source = self._rng or random
            offset = source.randrange(maximum_offset + 1) if maximum_offset else 0
            url = (
                f"{origin}/channel/{quote(channel)}/{date.year}/{date.month}{suffix}"
                f"?jsonBasic=1&limit={candidate_limit}&offset={offset}"
            )
            try:
                payload = await self._client.get_json(
                    url,
                    timeout_ms=14_000,
                    max_bytes=ARCHIVE_RESPONSE_MAX_BYTES,
                    user_agent="KnowTheChat/1.0",
                    cache_ttl=cache_ttl,
                )
            except HttpResponseTooLargeError:
                # Mirrors hold equivalent daily archives. Retrying the same date
                # elsewhere would download another oversized body with no benefit.
                raise
            raw_messages = payload.get("messages") if isinstance(payload, dict) else None
            if not isinstance(raw_messages, list):
                continue
            candidates = _sample_evenly(raw_messages, candidate_limit)
            parsed: list[Message] = []
            for value in candidates:
                if not isinstance(value, dict):
                    continue
                message = parse_historical_message(value)
                if message is not None:
                    parsed.append(message)
                if len(parsed) >= message_limit:
                    break
            if parsed:
                return parsed
        return []

    async def _fetch_message_count(
        self, origin: str, channel: str, date: ArchiveDate, *, cache_ttl: int
    ) -> int:
        start, end = self._date_bounds(date)
        payload = await self._client.get_json(
            f"{origin}/channel/{quote(channel)}/stats?from={quote(start)}&to={quote(end)}",
            timeout_ms=12_000,
            max_bytes=ARCHIVE_STATS_MAX_BYTES,
            user_agent="KnowTheChat/1.0",
            cache_ttl=cache_ttl,
        )
        message_count = payload.get("messageCount") if isinstance(payload, dict) else None
        return (
            message_count
            if isinstance(message_count, int) and not isinstance(message_count, bool)
            else 0
        )

    @staticmethod
    def _date_bounds(date: ArchiveDate) -> tuple[str, str]:
        year, month = int(date.year), int(date.month)
        day = int(date.day or 1)
        start = datetime(year, month, day, tzinfo=UTC)
        if date.day:
            end = start.replace(hour=23, minute=59, second=59, microsecond=999_999)
        else:
            next_month = (
                datetime(year + 1, 1, 1, tzinfo=UTC)
                if month == 12
                else datetime(year, month + 1, 1, tzinfo=UTC)
            )
            end = next_month - timedelta(milliseconds=1)
        return (
            start.isoformat().replace("+00:00", "Z"),
            end.isoformat().replace("+00:00", "Z"),
        )


class RecentMessagesProvider:
    def __init__(self, client: JsonHttpClient, base_url: str) -> None:
        self._client = client
        self._base_url = base_url

    async def fetch(self, channel: str, limit: int) -> list[str]:
        payload = await self._client.get_json(
            f"{self._base_url}{quote(channel)}?limit={limit}",
            timeout_ms=12_000,
            max_bytes=5_000_000,
            user_agent="KnowTheChat/1.0 public archive game",
        )
        raw_messages = payload.get("messages") if isinstance(payload, dict) else None
        return (
            [value for value in raw_messages if isinstance(value, str)]
            if isinstance(raw_messages, list)
            else []
        )
