from __future__ import annotations

from typing import Any, Protocol

from domain.models import Message


class JsonHttpClient(Protocol):
    async def get_json(
        self,
        url: str,
        *,
        timeout_ms: int,
        max_bytes: int,
        user_agent: str,
        cache_ttl: int | None = None,
    ) -> Any | None: ...


class HistoricalArchiveProvider(Protocol):
    async def fetch(
        self, channel: str, cutoff_ms: float, range_days: float | None
    ) -> list[Message]: ...


class RecentArchiveProvider(Protocol):
    async def fetch(self, channel: str, limit: int) -> list[str]: ...


class EmoteProvider(Protocol):
    async def fetch(self, room_id: str) -> dict[str, str]: ...
