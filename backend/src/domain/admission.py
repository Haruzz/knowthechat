"""Admission policy and the small interface used by lobby orchestration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from domain.rooms import RoomError

MINUTE_MS = 60 * 1_000
DAY_MS = 24 * 60 * MINUTE_MS
PENDING_LEASE_MS = 2 * MINUTE_MS
MAX_CONFIGURED_LIMIT = 10_000


@dataclass(frozen=True, slots=True)
class Reservation:
    id: str
    expires_at: int


class AdmissionGateway(Protocol):
    async def reserve(self, creator_key: str) -> Reservation: ...

    async def activate(self, lease_id: str, expires_at: int) -> None: ...

    async def release(self, lease_id: str) -> None: ...

    async def admit_match(self, lease_id: str, match_number: int) -> None: ...


def _limit(env: object, name: str, default: int) -> int:
    # Wrangler text variables are strings. Reject accidental booleans, objects,
    # fractions and oversized values instead of silently disabling a limit.
    value: object = getattr(env, name, str(default))
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise RoomError("Lobbies are temporarily unavailable. Please try again.", 503)
    if len(value) > 5 or not 1 <= int(value) <= MAX_CONFIGURED_LIMIT:
        raise RoomError("Lobbies are temporarily unavailable. Please try again.", 503)
    return int(value)


@dataclass(frozen=True, slots=True)
class AdmissionSettings:
    max_open: int = 10
    preparations_per_day: int = 100
    matches_per_day: int = 100
    creations_per_minute: int = 3

    @classmethod
    def from_env(cls, env: object) -> AdmissionSettings:
        return cls(
            max_open=_limit(env, "ROOM_MAX_OPEN", 10),
            preparations_per_day=_limit(env, "ROOM_PREPARATIONS_PER_DAY", 100),
            matches_per_day=_limit(env, "ROOM_MATCHES_PER_DAY", 100),
            creations_per_minute=_limit(env, "ROOM_CREATIONS_PER_MINUTE", 3),
        )


def retry_seconds(available_at: int, now: int) -> int:
    """Round up so Retry-After never tells a client to retry before admission opens."""
    return max(1, (available_at - now + 999) // 1_000)
