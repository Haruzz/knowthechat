from __future__ import annotations

from dataclasses import replace

import pytest

from api_models import PublicArchiveRequest
from domain.models import Message
from services.public_archive import NoPublicArchiveError, PublicArchiveService


def make_message(index: int, *, user_id: str = "u1", name: str = "Alice") -> Message:
    body = (
        f"This distinctive message has token{index}alpha token{index}beta "
        f"token{index}gamma and useful details?"
    )
    return Message(
        id=f"m-{user_id}-{index}",
        user_id=user_id,
        room_id="99",
        name=name,
        body=body,
        normalized=body.lower().replace("?", ""),
        emotes=(),
        sent_at=1_700_000_000_000 + index * 1_000,
        sub=False,
        vip=False,
        mod=False,
    )


class FakeHistorical:
    def __init__(
        self, messages: list[Message] | None = None, error: Exception | None = None
    ) -> None:
        self.messages = messages or []
        self.error = error

    async def fetch(
        self, channel: str, cutoff_ms: float, range_days: float | None
    ) -> list[Message]:
        if self.error:
            raise self.error
        return self.messages


class FakeRecent:
    def __init__(self, messages: list[str] | None = None, error: Exception | None = None) -> None:
        self.messages = messages or []
        self.error = error
        self.calls = 0

    async def fetch(self, channel: str, limit: int) -> list[str]:
        self.calls += 1
        if self.error:
            raise self.error
        return self.messages


class FakeEmotes:
    def __init__(
        self, catalog: dict[str, str] | None = None, error: Exception | None = None
    ) -> None:
        self.catalog = catalog or {}
        self.error = error

    async def fetch(self, room_id: str) -> dict[str, str]:
        if self.error:
            raise self.error
        return self.catalog


def service(historical, recent=(), emotes=()) -> PublicArchiveService:
    return PublicArchiveService(
        historical,
        recent,
        emotes,
        now_ms=lambda: 1_700_100_000_000,
        logger=lambda *args, **kwargs: None,
    )


@pytest.mark.asyncio
async def test_sufficient_historical_archive_skips_recent_fallback() -> None:
    historical = [
        make_message(index, user_id=f"u{index % 3}", name=f"User{index % 3}")
        for index in range(100)
    ]
    recent = FakeRecent([])
    response = await service(FakeHistorical(historical), [recent]).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "rangeDays": "all", "chatterPool": 25}
        )
    )
    assert recent.calls == 0
    assert response.total > 0


@pytest.mark.asyncio
async def test_sparse_historical_archive_uses_recent_fallback() -> None:
    recent = FakeRecent([])
    response = await service(FakeHistorical([make_message(i) for i in range(3)]), [recent]).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "rangeDays": "all", "chatterPool": 25}
        )
    )
    assert recent.calls == 1
    assert response.total == 3


@pytest.mark.asyncio
async def test_all_archive_providers_failing_returns_no_archive() -> None:
    worker = service(
        FakeHistorical(error=RuntimeError("down")), [FakeRecent(error=RuntimeError("down"))]
    )
    with pytest.raises(NoPublicArchiveError):
        await worker.execute(PublicArchiveRequest.model_validate({"channel": "channel"}))


@pytest.mark.asyncio
async def test_emote_failure_does_not_block_response() -> None:
    response = await service(
        FakeHistorical([make_message(i) for i in range(3)]),
        [],
        [FakeEmotes(error=RuntimeError("down"))],
    ).execute(PublicArchiveRequest.model_validate({"channel": "channel", "rangeDays": "all"}))
    assert response.total == 3


@pytest.mark.asyncio
async def test_exact_and_near_duplicates_are_removed() -> None:
    first = make_message(1)
    exact_id = replace(make_message(2), id=first.id)
    exact_text = replace(make_message(3), normalized=first.normalized)
    near = replace(
        make_message(4),
        normalized=first.normalized.replace("token1gamma", "token4gamma"),
    )
    response = await service(FakeHistorical([first, exact_id, exact_text, near])).execute(
        PublicArchiveRequest.model_validate({"channel": "channel", "rangeDays": "all"})
    )
    assert response.total == 1
