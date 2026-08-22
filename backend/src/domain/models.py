from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class EmoteSpan:
    id: str
    start: int
    end: int
    url: str | None = None


@dataclass(frozen=True, slots=True)
class Message:
    id: str
    user_id: str
    room_id: str
    name: str
    body: str
    normalized: str
    emotes: tuple[EmoteSpan, ...]
    sent_at: float
    sub: bool
    vip: bool
    mod: bool


@dataclass(frozen=True, slots=True)
class ArchiveDate:
    year: str
    month: str
    day: str | None = None


@dataclass(slots=True)
class ChatterAggregate:
    id: str
    name: str
    messages: int
    sub: bool
    vip: bool
    mod: bool
    days: set[str] = field(default_factory=set)
    months: set[str] = field(default_factory=set)
    total_words: int = 0


@dataclass(frozen=True, slots=True)
class RankedChatter:
    id: str
    name: str
    messages: int
    sub: bool
    vip: bool
    mod: bool
    active_days: int
    active_months: int
    avg_words: int
    score: int
