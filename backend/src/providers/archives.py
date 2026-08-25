from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from domain.models import ArchiveDate, Message
from domain.parsing import parse_historical_message
from domain.sampling import date_buckets, date_key
from providers.protocols import (
    ArchiveProviderUnavailableError,
    ArchiveTooLargeError,
    ArchiveYearUnavailableError,
    HistoricalArchiveNotFoundError,
    HttpResponseTooLargeError,
    JsonHttpClient,
)

HISTORY_ORIGIN = "https://logs.zonian.dev"
ARCHIVE_LIST_CACHE_TTL = 300
ARCHIVE_DISCOVERY_MAX_BYTES = 2_000_000
ARCHIVE_LIST_MAX_BYTES = 1_000_000
ARCHIVE_STATS_MAX_BYTES = 100_000
ARCHIVE_RESPONSE_MAX_BYTES = 10_000_000
HISTORICAL_FETCH_CONCURRENCY = 1
ARCHIVE_STATS_CONCURRENCY = 6
MAX_ARCHIVE_INSTANCES = 6
MAX_HISTORICAL_DATES = 12
MAX_EXPANSION_DATES = 6
MAX_HISTORICAL_MESSAGES = 6_000
MAX_HISTORICAL_MESSAGES_PER_DATE = 1_000
INITIAL_WINDOWS_PER_DATE = 2
EXPANSION_WINDOWS_PER_DATE = 4
ACTIVITY_CANDIDATES_PER_BUCKET = 3
MAX_OVERSIZED_ARCHIVE_DATES = 2
INITIAL_PARSE_CANDIDATE_MULTIPLIER = 4
EXPANSION_PARSE_CANDIDATE_MULTIPLIER = 8
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
    def __init__(self, client: JsonHttpClient) -> None:
        self._client = client

    async def fetch(
        self,
        channel: str,
        cutoff_ms: float,
        range_days: float | None,
        archive_year: int | None = None,
        sampling_pass: int = 1,
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

        if not successful_lists:
            raise ArchiveProviderUnavailableError
        if archive_year is not None and successful_lists and not locations:
            raise ArchiveYearUnavailableError(archive_year)
        if not locations:
            return []

        maximum = _maximum_dates(range_days)
        if sampling_pass > 1:
            maximum = min(maximum, MAX_EXPANSION_DATES)
        chosen_counts = await self._choose_active_dates(channel, locations, maximum)
        chosen = list(chosen_counts)
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
                    self._fetch_date(
                        channel,
                        date,
                        tuple(locations[date]),
                        per_date_limit,
                        chosen_counts[date],
                        sampling_pass,
                    )
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

    async def _choose_active_dates(
        self,
        channel: str,
        locations: dict[ArchiveDate, list[str]],
        maximum: int,
    ) -> dict[ArchiveDate, int]:
        buckets = date_buckets(list(locations), maximum)
        candidates = [
            date
            for bucket in buckets
            for date in _sample_evenly(bucket, ACTIVITY_CANDIDATES_PER_BUCKET)
        ]
        semaphore = asyncio.Semaphore(ARCHIVE_STATS_CONCURRENCY)

        async def activity(date: ArchiveDate) -> tuple[ArchiveDate, int]:
            async with semaphore:
                today = datetime.now(UTC).date().isoformat()
                cache_ttl = 300 if date_key(date) == today else 86_400
                try:
                    count = await self._fetch_message_count(
                        locations[date][0], channel, date, cache_ttl=cache_ttl
                    )
                except Exception:
                    count = 0
                return date, count

        counts = dict(await asyncio.gather(*(activity(date) for date in candidates)))
        chosen: dict[ArchiveDate, int] = {}
        for bucket in buckets:
            bucket_candidates = _sample_evenly(bucket, ACTIVITY_CANDIDATES_PER_BUCKET)
            midpoint = (len(bucket) - 1) / 2
            positions = {date: bucket.index(date) for date in bucket_candidates}
            date = max(
                bucket_candidates,
                key=lambda candidate: (
                    counts[candidate],
                    -abs(positions[candidate] - midpoint),
                    date_key(candidate),
                ),
            )
            chosen[date] = counts[date]
        return chosen

    async def _discover_origins(self, channel: str) -> tuple[str, ...]:
        payload = await self._client.get_json(
            f"{HISTORY_ORIGIN}/api/{quote(channel)}",
            timeout_ms=12_000,
            max_bytes=ARCHIVE_DISCOVERY_MAX_BYTES,
            user_agent="KnowTheChat/1.0",
            cache_ttl=ARCHIVE_LIST_CACHE_TTL,
            accepted_statuses=(404,),
        )
        if payload is None:
            raise ArchiveProviderUnavailableError
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
        if origins:
            return tuple(origins)
        available = payload.get("available") if isinstance(payload, dict) else None
        channel_available = available.get("channel") if isinstance(available, dict) else None
        if channel_available is False or (
            isinstance(payload, dict) and payload.get("status") == 404
        ):
            raise HistoricalArchiveNotFoundError
        return (HISTORY_ORIGIN,)

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
        self,
        channel: str,
        date: ArchiveDate,
        origins: tuple[str, ...],
        message_limit: int,
        message_count: int,
        sampling_pass: int,
    ) -> list[Message]:
        suffix = f"/{date.day}" if date.day else ""
        today = datetime.now(UTC).date().isoformat()
        initial_candidate_limit = message_limit * INITIAL_PARSE_CANDIDATE_MULTIPLIER
        parse_candidate_multiplier = (
            INITIAL_PARSE_CANDIDATE_MULTIPLIER
            if sampling_pass == 1
            else EXPANSION_PARSE_CANDIDATE_MULTIPLIER
        )
        for origin in origins:
            cache_ttl = 300 if date_key(date) == today else 86_400
            parsed: list[Message] = []
            if sampling_pass > 1 and message_count <= initial_candidate_limit:
                return []
            window_count = 1
            if message_count > initial_candidate_limit:
                window_count = min(
                    INITIAL_WINDOWS_PER_DATE if sampling_pass == 1 else EXPANSION_WINDOWS_PER_DATE,
                    message_limit,
                )
            for window_index in range(window_count):
                window_quota = message_limit // window_count + int(
                    window_index < message_limit % window_count
                )
                window_limit = window_quota * parse_candidate_multiplier
                if sampling_pass == 1:
                    center = (2 * window_index + 1) * message_count // (2 * window_count)
                else:
                    center = (
                        (2 * window_index + 1) * message_count // (2 * EXPANSION_WINDOWS_PER_DATE)
                    )
                offset = min(
                    max(0, center - window_limit // 2),
                    max(0, message_count - window_limit),
                )
                url = (
                    f"{origin}/channel/{quote(channel)}/{date.year}/{date.month}{suffix}"
                    f"?jsonBasic=1&limit={window_limit}&offset={offset}"
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
                window_messages = 0
                for value in _sample_evenly(raw_messages, window_limit):
                    if not isinstance(value, dict):
                        continue
                    message = parse_historical_message(value)
                    if message is not None:
                        parsed.append(message)
                        window_messages += 1
                    if window_messages >= window_quota:
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
