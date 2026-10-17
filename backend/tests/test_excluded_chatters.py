from dataclasses import replace

import pytest
from test_domain import _irc_message
from test_rooms import FakeArchive
from test_service import FakeHistorical, make_message, service

from api_models import PublicArchiveRequest
from domain.filtering import contains_excluded_chatter, is_excluded_chatter
from domain.parsing import parse_historical_message, parse_irc_message
from services.rooms import build_rounds


@pytest.mark.parametrize("name", ["sheepmuffin", "SheepMuffin", "SHEEPMUFFIN"])
def test_excluded_author_cannot_enter_either_archive_parser(name: str) -> None:
    assert is_excluded_chatter(name)
    assert (
        parse_irc_message(_irc_message().replace("display-name=Alice", f"display-name={name}"))
        is None
    )
    assert parse_irc_message(_irc_message().replace(":alice!", f":{name}!")) is None
    assert (
        parse_historical_message(
            {
                "id": "excluded",
                "displayName": name,
                "text": "This is a distinctive archived message, surely?",
                "timestamp": "2026-01-01T00:00:00Z",
                "tags": {"user-id": "123"},
            }
        )
        is None
    )


def test_mentions_are_excluded_without_blocking_different_usernames() -> None:
    for text in (
        "SheepMuffin said something memorable today",
        "That was sheepmuffin's idea",
        "Hello @SHEEPMUFFIN!",
    ):
        assert contains_excluded_chatter(text)
    assert not contains_excluded_chatter("sheepmuffin2 has a different username")
    assert not is_excluded_chatter("sheepmuffin2")
    assert parse_irc_message(_irc_message().replace("distinctive", "sheepmuffin")) is None
    assert parse_irc_message(_irc_message()) is not None


@pytest.mark.asyncio
async def test_exclusion_precedes_ranking_and_quote_selection() -> None:
    allowed = [make_message(i, user_id=f"u{i % 3}", name=f"User{i % 3}") for i in range(12)]
    blocked = make_message(99, user_id="excluded", name="SheepMuffin")
    mention = replace(
        make_message(100), body="Sheepmuffin made this wonderfully distinctive suggestion"
    )
    archive = await service(FakeHistorical([*allowed, blocked, mention])).execute(
        PublicArchiveRequest.model_validate({"channel": "example", "archiveYear": 2023})
    )
    assert archive.total == len(allowed)
    assert all(not is_excluded_chatter(chatter.name) for chatter in archive.chatters)
    assert all(q.id not in (blocked.id, mention.id) for q in archive.quotes)


@pytest.mark.asyncio
async def test_multiplayer_never_uses_excluded_author_as_clue_or_wrong_choice() -> None:
    archive = await FakeArchive(15).execute(
        PublicArchiveRequest.model_validate({"channel": "example"})
    )
    archive.chatters.append(archive.chatters[0].model_copy(update={"name": "SHEEPMUFFIN"}))
    archive.quotes[0] = archive.quotes[0].model_copy(update={"author": "SHEEPMUFFIN"})
    archive.quotes[1] = archive.quotes[1].model_copy(
        update={"text": "Sheepmuffin made this wonderfully distinctive suggestion"}
    )
    rounds = build_rounds(archive, 10)
    assert all(not is_excluded_chatter(choice) for r in rounds for choice in r.choices)
    assert all(
        not is_excluded_chatter(r.author) and not contains_excluded_chatter(r.text) for r in rounds
    )
