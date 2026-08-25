from __future__ import annotations

import json
from dataclasses import replace

import pytest

from api_models import PublicArchiveRequest
from domain.models import Message
from providers.protocols import (
    ArchiveProviderUnavailableError,
    ArchiveTooLargeError,
    ArchiveYearUnavailableError,
    HistoricalArchiveNotFoundError,
)
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


def make_recent_message(index: int, *, sent_at: int = 1_700_000_000_000) -> str:
    return (
        f"@display-name=RecentUser;user-id=recent-user;room-id=99;id=recent-{index};"
        f"tmi-sent-ts={sent_at + index * 1_000};badges=;emotes= "
        f":recentuser!recentuser@recentuser.tmi.twitch.tv PRIVMSG #channel "
        f":This recent message has alpha{index} beta{index} gamma{index} and useful details?"
    )


class FakeHistorical:
    def __init__(
        self,
        messages: list[Message] | None = None,
        error: Exception | None = None,
        expansion_messages: list[Message] | None = None,
        expansion_error: Exception | None = None,
    ) -> None:
        self.messages = messages or []
        self.error = error
        self.expansion_messages = expansion_messages or []
        self.expansion_error = expansion_error
        self.sampling_passes: list[int] = []

    async def fetch(
        self,
        channel: str,
        cutoff_ms: float,
        range_days: float | None,
        archive_year: int | None = None,
        sampling_pass: int = 1,
    ) -> list[Message]:
        self.sampling_passes.append(sampling_pass)
        if sampling_pass > 1:
            if self.expansion_error:
                raise self.expansion_error
            return self.expansion_messages
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
    assert response.source == "historical"


@pytest.mark.asyncio
async def test_sparse_historical_archive_does_not_use_recent_fallback() -> None:
    recent = FakeRecent([])
    response = await service(FakeHistorical([make_message(i) for i in range(3)]), [recent]).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "rangeDays": 90, "chatterPool": 25}
        )
    )
    assert recent.calls == 0
    assert response.total == 3
    assert response.source == "historical"
    assert {quote.difficulty for quote in response.quotes} == {"easy"}


@pytest.mark.asyncio
async def test_sparse_playable_pool_gets_one_bounded_expansion_pass() -> None:
    initial = [make_message(index) for index in range(3)]
    extra = [make_message(index) for index in range(3, 8)]
    historical = FakeHistorical(initial, expansion_messages=extra)

    response = await service(historical).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "archiveYear": 2023, "chatterPool": 25}
        )
    )

    assert historical.sampling_passes == [1, 2]
    assert response.total == 8
    assert len(response.quotes) == 8


@pytest.mark.asyncio
async def test_full_playable_pool_skips_expansion() -> None:
    messages = [
        make_message(author * 100 + quote, user_id=f"u{author}", name=f"User{author}")
        for author in range(25)
        for quote in range(15)
    ]
    historical = FakeHistorical(messages)

    response = await service(historical).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "archiveYear": 2023, "chatterPool": 25}
        )
    )

    assert historical.sampling_passes == [1]
    assert len(response.quotes) == 375


@pytest.mark.asyncio
async def test_response_quotes_are_representative_and_bounded_per_chatter() -> None:
    historical = FakeHistorical([make_message(index) for index in range(30)])

    response = await service(historical).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "archiveYear": 2023, "chatterPool": 25}
        )
    )

    assert len(response.quotes) == 25
    assert response.quotes[0].id == "m-u1-0"
    assert response.quotes[-1].id == "m-u1-29"


@pytest.mark.asyncio
async def test_expansion_failure_keeps_the_initial_game() -> None:
    historical = FakeHistorical(
        [make_message(index) for index in range(3)],
        expansion_error=ArchiveProviderUnavailableError(),
    )

    response = await service(historical).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "archiveYear": 2023, "chatterPool": 25}
        )
    )

    assert historical.sampling_passes == [1, 2]
    assert response.total == 3


@pytest.mark.asyncio
async def test_missing_archive_uses_recent_fallback_for_rolling_period() -> None:
    recent = FakeRecent([make_recent_message(index) for index in range(3)])
    response = await service(
        FakeHistorical(error=HistoricalArchiveNotFoundError()), [recent]
    ).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "rangeDays": 90, "chatterPool": 25}
        )
    )
    assert recent.calls == 1
    assert response.total == 3
    assert response.source == "recent"


@pytest.mark.asyncio
async def test_missing_archive_uses_recent_fallback_for_current_year() -> None:
    recent = FakeRecent(
        [
            *[make_recent_message(index) for index in range(3)],
            make_recent_message(99, sent_at=1_660_000_000_000),
        ]
    )
    response = await service(
        FakeHistorical(error=HistoricalArchiveNotFoundError()), [recent]
    ).execute(
        PublicArchiveRequest.model_validate(
            {"channel": "channel", "archiveYear": 2023, "chatterPool": 25}
        )
    )
    assert recent.calls == 1
    assert response.total == 3
    assert response.source == "recent"


@pytest.mark.asyncio
async def test_missing_archive_does_not_use_recent_fallback_for_past_year() -> None:
    recent = FakeRecent([make_recent_message(index) for index in range(3)])
    with pytest.raises(NoPublicArchiveError, match="2022"):
        await service(FakeHistorical(error=HistoricalArchiveNotFoundError()), [recent]).execute(
            PublicArchiveRequest.model_validate(
                {"channel": "channel", "archiveYear": 2022, "chatterPool": 25}
            )
        )
    assert recent.calls == 0


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
    assert response.source == "historical"


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
async def test_historical_provider_failure_does_not_silently_use_recent_messages() -> None:
    recent = FakeRecent([make_recent_message(1)])
    worker = service(FakeHistorical(error=RuntimeError("down")), [recent])
    with pytest.raises(ArchiveProviderUnavailableError):
        await worker.execute(PublicArchiveRequest.model_validate({"channel": "channel"}))
    assert recent.calls == 0


@pytest.mark.asyncio
async def test_all_recent_providers_failing_reports_temporary_unavailability() -> None:
    worker = service(
        FakeHistorical(error=HistoricalArchiveNotFoundError()),
        [FakeRecent(error=RuntimeError("down"))],
    )
    with pytest.raises(ArchiveProviderUnavailableError):
        await worker.execute(
            PublicArchiveRequest.model_validate({"channel": "channel", "rangeDays": 90})
        )


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
