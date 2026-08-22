from __future__ import annotations

import json
from dataclasses import replace

import pytest

from api_models import PublicArchiveRequest
from domain.models import Message
from providers.protocols import ArchiveTooLargeError, ArchiveYearUnavailableError
from services.public_archive import NoPublicArchiveError, PublicArchiveService, StructuredLogger


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
        self,
        channel: str,
        cutoff_ms: float,
        range_days: float | None,
        archive_year: int | None = None,
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


def test_structured_logger_includes_a_visible_message(
    capsys: pytest.CaptureFixture[str],
) -> None:
    StructuredLogger()(
        "request_summary",
        message="Public archive request completed.",
        total=3,
    )

    assert json.loads(capsys.readouterr().out) == {
        "message": "Public archive request completed.",
        "event": "request_summary",
        "total": 3,
    }


@pytest.mark.asyncio
async def test_request_emits_one_consolidated_success_log() -> None:
    events: list[tuple[str, dict[str, object]]] = []
    worker = PublicArchiveService(
        FakeHistorical([make_message(index) for index in range(3)]),
        [],
        [],
        now_ms=lambda: 1_700_100_000_000,
        logger=lambda event, **fields: events.append((event, fields)),
    )

    response = await worker.execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "archiveYear": 2023, "chatterPool": 25}
        )
    )

    assert response.total == 3
    assert len(events) == 1
    event, fields = events[0]
    assert event == "request_summary"
    assert fields["message"] == "Public archive request completed."
    assert fields["outcome"] == "success"
    assert fields["historical_messages"] == 3
    assert fields["accepted_messages"] == 3
    assert fields["response_messages"] == 3


@pytest.mark.asyncio
async def test_request_emits_one_consolidated_not_found_log() -> None:
    events: list[tuple[str, dict[str, object]]] = []
    worker = PublicArchiveService(
        FakeHistorical(error=ArchiveYearUnavailableError(2022)),
        [],
        [],
        now_ms=lambda: 1_700_100_000_000,
        logger=lambda event, **fields: events.append((event, fields)),
    )

    with pytest.raises(NoPublicArchiveError):
        await worker.execute(
            PublicArchiveRequest.model_validate({"channel": "channel", "archiveYear": 2022})
        )

    assert len(events) == 1
    event, fields = events[0]
    assert event == "request_summary"
    assert fields["outcome"] == "not_found"
    assert fields["historical_error_type"] == "ArchiveYearUnavailableError"


@pytest.mark.asyncio
async def test_sufficient_historical_archive_skips_recent_fallback() -> None:
    historical = [
        make_message(index, user_id=f"u{index % 3}", name=f"User{index % 3}")
        for index in range(100)
    ]
    recent = FakeRecent([])
    response = await service(FakeHistorical(historical), [recent]).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "rangeDays": 90, "chatterPool": 25}
        )
    )
    assert recent.calls == 0
    assert response.total > 0


@pytest.mark.asyncio
async def test_sparse_historical_archive_uses_recent_fallback() -> None:
    recent = FakeRecent([])
    response = await service(FakeHistorical([make_message(i) for i in range(3)]), [recent]).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "rangeDays": 90, "chatterPool": 25}
        )
    )
    assert recent.calls == 1
    assert response.total == 3


@pytest.mark.asyncio
async def test_calendar_year_never_mixes_in_recent_messages() -> None:
    recent = FakeRecent([])
    response = await service(FakeHistorical([make_message(i) for i in range(3)]), [recent]).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "archiveYear": 2023, "chatterPool": 25}
        )
    )
    assert recent.calls == 0
    assert response.total == 3


@pytest.mark.asyncio
async def test_unavailable_calendar_year_has_a_specific_error() -> None:
    worker = service(FakeHistorical(error=ArchiveYearUnavailableError(2022)))
    with pytest.raises(NoPublicArchiveError, match="No public archive is available for 2022"):
        await worker.execute(
            PublicArchiveRequest.model_validate({"channel": "channel", "archiveYear": 2022})
        )


@pytest.mark.asyncio
async def test_oversized_calendar_year_has_a_specific_error() -> None:
    worker = service(FakeHistorical(error=ArchiveTooLargeError(2025)))
    with pytest.raises(NoPublicArchiveError, match=r"2025 archive.*too large"):
        await worker.execute(
            PublicArchiveRequest.model_validate({"channel": "channel", "archiveYear": 2025})
        )


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
    ).execute(PublicArchiveRequest.model_validate({"channel": "channel", "rangeDays": 90}))
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
        PublicArchiveRequest.model_validate({"channel": "channel", "rangeDays": 90})
    )
    assert response.total == 1
