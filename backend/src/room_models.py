from __future__ import annotations

import unicodedata
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from api_models import PublicArchiveRequest


def normalize_name(value: str) -> str:
    name = " ".join(value.split())
    if not 1 <= len(name) <= 20 or any(unicodedata.category(char).startswith("C") for char in name):
        raise ValueError("Use a display name with 1-20 visible characters.")
    return name


class JoinRoomRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(max_length=80)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return normalize_name(value)


class CreateRoomRequest(PublicArchiveRequest):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    name: str = Field(max_length=80)
    round_count: Literal[5, 10, 20] = Field(10, alias="roundCount")
    round_seconds: Literal[15, 20, 30] = Field(20, alias="roundSeconds")

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return normalize_name(value)

    def archive_request(self) -> PublicArchiveRequest:
        return PublicArchiveRequest(
            channel=self.channel,
            archiveYear=self.archive_year,
            rangeDays=self.range_days,
            chatterPool=self.chatter_pool,
        )


class GuessRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    round_id: str = Field(alias="roundId", min_length=1, max_length=64)
    choice: str = Field(min_length=1, max_length=50)


class EmptyRoomRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
