from __future__ import annotations

import math
import re
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class PublicArchiveRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    channel: str
    range_days: float | None = Field(None, alias="rangeDays")
    archive_year: int | None = Field(None, alias="archiveYear")
    chatter_pool: Literal[25, 50, 100] = Field(50, alias="chatterPool")

    @model_validator(mode="after")
    def select_archive_period(self) -> PublicArchiveRequest:
        if self.archive_year is not None:
            self.range_days = None
        elif self.range_days is None:
            self.archive_year = datetime.now(UTC).year
        return self

    @field_validator("channel", mode="before")
    @classmethod
    def validate_channel(cls, value: Any) -> str:
        channel = value.strip().lower().removeprefix("@") if isinstance(value, str) else ""
        if not re.fullmatch(r"[a-z0-9_]{3,25}", channel):
            raise ValueError("Enter a valid Twitch channel name.")
        return channel

    @field_validator("range_days", mode="before")
    @classmethod
    def coerce_range_days(cls, value: Any) -> float | None:
        if value is None or value == "":
            return None
        try:
            if isinstance(value, bool):
                number = float(value)
            else:
                number = float(value)
        except (TypeError, ValueError):
            number = math.nan
        if not math.isfinite(number) or number == 0:
            number = 90
        return min(90, max(1, number))

    @field_validator("archive_year", mode="before")
    @classmethod
    def coerce_archive_year(cls, value: Any) -> int | None:
        if value is None or value == "":
            return None
        try:
            year = int(value)
        except (TypeError, ValueError):
            return datetime.now(UTC).year
        return min(datetime.now(UTC).year, max(2011, year))

    @field_validator("chatter_pool", mode="before")
    @classmethod
    def coerce_chatter_pool(cls, value: Any) -> int:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return 50
        return int(number) if number in (25, 50, 100) else 50


class EmoteResponse(BaseModel):
    id: str
    start: int
    end: int
    url: str | None = None


class QuoteResponse(BaseModel):
    id: str
    author: str
    text: str
    emotes: list[EmoteResponse]
    sent_at: float = Field(alias="sentAt")
    quality: int
    difficulty: Literal["easy", "medium", "hard"]


class ChatterResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    messages: int
    sub: bool
    vip: bool
    mod: bool
    active_days: int = Field(alias="activeDays")
    active_months: int = Field(alias="activeMonths")
    avg_words: int = Field(alias="avgWords")
    score: int
    avatar: str


class ArchiveRangeResponse(BaseModel):
    oldest: float
    newest: float


class PublicArchiveResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    channel: str
    room_id: str = Field(alias="roomId")
    chatters: list[ChatterResponse]
    quotes: list[QuoteResponse]
    total: int
    range: ArchiveRangeResponse | None
    source: Literal["historical", "recent"]


class ErrorResponse(BaseModel):
    error: str
