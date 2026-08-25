from __future__ import annotations

from typing import Any, Protocol

from domain.models import Message


class ArchiveYearUnavailableError(Exception):
    def __init__(self, year: int) -> None:
        self.year = year
        super().__init__(f"No public archive is available for {year}.")


class ArchiveTooLargeError(Exception):
    def __init__(self, year: int | None) -> None:
        self.year = year
        period = f"The {year} archive" if year is not None else "The requested archive"
        super().__init__(
            f"{period} for this channel is too large to process safely. Try a shorter lookback."
        )


class HistoricalArchiveNotFoundError(Exception):
    """The channel has no discoverable long-term public archive."""


class ArchiveProviderUnavailableError(Exception):
    def __init__(self) -> None:
        super().__init__("The public archive service is temporarily unavailable. Try again.")


class HttpResponseTooLargeError(Exception):
    """An upstream body exceeded the caller's explicit byte limit."""

    def __init__(self, maximum: int) -> None:
        self.maximum = maximum
        super().__init__(f"Upstream response exceeded {maximum} bytes.")


class JsonHttpClient(Protocol):
    async def get_json(
        self,
        url: str,
        *,
        timeout_ms: int,
        max_bytes: int,
        user_agent: str,
        cache_ttl: int | None = None,
        accepted_statuses: tuple[int, ...] = (),
    ) -> Any | None: ...


class HistoricalArchiveProvider(Protocol):
    async def fetch(
        self,
        channel: str,
        cutoff_ms: float,
        range_days: float | None,
        archive_year: int | None = None,
        sampling_pass: int = 1,
    ) -> list[Message]: ...


class RecentArchiveProvider(Protocol):
    async def fetch(self, channel: str, limit: int) -> list[str]: ...


class EmoteProvider(Protocol):
    async def fetch(self, room_id: str) -> dict[str, str]: ...
