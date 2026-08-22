from __future__ import annotations

import random
from datetime import UTC, datetime

from domain.duplicates import NearDuplicateIndex
from domain.filtering import is_known_bot, is_low_quality, is_twitch_event_notice
from domain.models import ArchiveDate, Message
from domain.parsing import parse_historical_message, parse_irc_message, unescape_irc_tag
from domain.ranking import rank_chatters
from domain.sampling import sample_dates, sample_even_dates
from domain.scoring import score_recognizability
from domain.text import (
    add_third_party_spans,
    normalize_message,
    parse_twitch_emotes,
    utf16_length,
)


def test_normalization_and_irc_unescaping_contract() -> None:
    normalization_cases = [
        "  Hello,   WORLD!!  ",
        "Héllø 世界 \uff11\uff12\uff13 🎉",
        "don't-stop_me.now",
        "tabs\tand\nnewlines",
    ]
    assert [normalize_message(value) for value in normalization_cases] == [
        "hello world",
        "héllø 世界 \uff11\uff12\uff13",
        "dontstopmenow",
        "tabs and newlines",
    ]
    escape_cases = [r"hello\sworld", r"semi\:colon", r"line\nnext", r"slash\\end"]
    assert [unescape_irc_tag(value) for value in escape_cases] == [
        "hello world",
        "semi;colon",
        "line\nnext",
        "slash\\end",
    ]


def test_emote_offsets_remain_javascript_utf16_units() -> None:
    body = "😀 Kappa is a memorable emote message"
    actual = [
        span.__dict__
        if hasattr(span, "__dict__")
        else {"id": span.id, "start": span.start, "end": span.end}
        for span in parse_twitch_emotes("25:3-7", utf16_length(body))
    ]
    assert actual == [{"id": "25", "start": 3, "end": 7}]
    spans = add_third_party_spans("😀 WowEmote words after it", (), {"WowEmote": "https://e/x"})
    assert (spans[0].start, spans[0].end) == (3, 10)


def test_filters_and_scoring_contract() -> None:
    bodies = [
        {"body": "This is a wonderfully distinctive sentence, right?"},
        {"body": "!points this should be filtered now"},
        {"body": "hello there friends in this channel"},
        {"body": "@someone this message mentions another chatter"},
        {"body": "Kappa Kappa Kappa Kappa", "emotes": "25:0-4,6-10,12-16,18-22"},
    ]
    assert [
        is_low_quality(value["body"], normalize_message(value["body"]), value.get("emotes", ""))
        for value in bodies
    ] == [False, True, False, True, True]
    bot_cases = ["NightBot", "human_name", "some-random-bot", "robotat"]
    assert [is_known_bot(value) for value in bot_cases] == [True, False, True, True]
    notices = [
        {"body": "ordinary words from a normal chatter today", "tags": {}},
        {"body": "ordinary words from a normal chatter today", "tags": {"msg-id": "sub"}},
        {"body": "Haruzz raided with 25 viewers!", "tags": {}},
    ]
    assert [is_twitch_event_notice(value["body"], value["tags"]) for value in notices] == [
        False,
        True,
        True,
    ]
    scoring_cases = [
        "This is a wonderfully distinctive sentence, right?",
        "four plain words right here",
        "In 2025, did somebody actually say this extraordinarily specific thing?",
    ]
    python_scores = [
        {"quality": quality, "difficulty": difficulty}
        for quality, difficulty in map(score_recognizability, scoring_cases)
    ]
    assert python_scores == [
        {"quality": 6, "difficulty": "medium"},
        {"quality": 3, "difficulty": "hard"},
        {"quality": 8, "difficulty": "easy"},
    ]


def _irc_message(
    message_id: str = "m1", user_id: str = "u1", timestamp: int = 1_700_000_000_000
) -> str:
    return (
        f"@badge-info=;badges=subscriber/1;color=#fff;display-name=Alice;emotes=;"
        f"id={message_id};room-id=99;tmi-sent-ts={timestamp};user-id={user_id} "
        ":alice!alice@alice.tmi.twitch.tv PRIVMSG #channel :"
        "This is a distinctive archived message, surely?"
    )


def test_irc_and_historical_parsing_contract() -> None:
    raw = _irc_message()
    actual = parse_irc_message(raw)
    assert actual is not None
    assert {
        "id": actual.id,
        "userId": actual.user_id,
        "roomId": actual.room_id,
        "name": actual.name,
        "body": actual.body,
        "normalized": actual.normalized,
        "sentAt": actual.sent_at,
        "sub": actual.sub,
        "vip": actual.vip,
        "mod": actual.mod,
    } == {
        "id": "m1",
        "userId": "u1",
        "roomId": "99",
        "name": "Alice",
        "body": "This is a distinctive archived message, surely?",
        "normalized": "this is a distinctive archived message surely",
        "sentAt": 1_700_000_000_000,
        "sub": True,
        "vip": False,
        "mod": False,
    }

    historical = {
        "id": "h1",
        "text": "This historical sentence is distinctive enough, right?",
        "displayName": "Bob",
        "timestamp": "2024-01-02T03:04:05.000Z",
        "tags": {"user-id": "u2", "room-id": "99", "badges": "vip/1", "emotes": ""},
    }
    actual_historical = parse_historical_message(historical)
    assert actual_historical is not None
    assert actual_historical.sent_at == 1_704_164_645_000
    assert actual_historical.vip is True


def test_near_duplicate_index_sequence() -> None:
    values = [
        "one two",
        "alpha beta gamma delta epsilon",
        "alpha beta gamma delta zeta",
        "alpha beta gamma delta epsilon with extra words added",
        "completely separate memorable sentence words",
    ]
    index = NearDuplicateIndex()
    actual = []
    for value in values:
        duplicate = index.has_near_duplicate(value)
        actual.append(duplicate)
        if not duplicate:
            index.add(value)
    assert actual == [True, False, False, False, False]


def test_date_sampling_is_deterministic_and_keeps_newest() -> None:
    days = [ArchiveDate("2024", "01", str(day)) for day in range(1, 21)]
    selected = sample_even_dates(days, 4, random.Random(7))
    assert len(selected) == 4
    assert selected[-1] == days[-1]
    months = [ArchiveDate("2023", str(month), "15") for month in range(1, 13)]
    selected_months = sample_dates(months, 6, random.Random(7))
    assert len(selected_months) == 6
    assert selected_months[-1] == months[-1]


def test_chatter_ranking_matches_current_formula() -> None:
    base = datetime(2024, 1, 1, tzinfo=UTC).timestamp() * 1000
    messages = [
        Message(
            id=f"m{index}",
            user_id="u1",
            room_id="99",
            name="Alice",
            body="A distinctive message with several useful words",
            normalized="a distinctive message with several useful words",
            emotes=(),
            sent_at=base + index * 86_400_000,
            sub=True,
            vip=False,
            mod=False,
        )
        for index in range(3)
    ]
    ranked, eligible = rank_chatters(messages, 25)
    assert eligible == {"u1"}
    assert ranked[0].messages == 3
    assert ranked[0].active_days == 3
    assert ranked[0].score == 22
