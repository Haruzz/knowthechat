from __future__ import annotations

import math
import re
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from domain.filtering import is_known_bot, is_low_quality, is_twitch_event_notice
from domain.models import Message
from domain.text import normalize_message, parse_twitch_emotes, utf16_length, utf16_slice

_URL = re.compile(r"https?://", re.IGNORECASE)


def unescape_irc_tag(value: str) -> str:
    return (
        value.replace(r"\s", " ")
        .replace(r"\:", ";")
        .replace(r"\r", "\r")
        .replace(r"\n", "\n")
        .replace("\\\\", "\\")
    )


def _badges(tags: Mapping[str, object]) -> str:
    value = tags.get("badges")
    return value if isinstance(value, str) else ""


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _number(value: object, fallback: float = 0) -> float:
    if isinstance(value, (str, int, float)):
        return float(value)
    return fallback


def _has_badge(badges: str, badge: str) -> bool:
    return bool(re.search(rf"(?:^|,){re.escape(badge)}/", badges))


def _valid_message(
    *,
    message_id: str,
    user_id: str,
    name: str,
    body: str,
    normalized: str,
    login: str,
    tags: dict[str, object],
    emote_tag: str,
    sent_at: float,
) -> bool:
    return not (
        not message_id
        or not user_id
        or not name
        or not math.isfinite(sent_at)
        or utf16_length(body) < 18
        or utf16_length(normalized) < 10
        or is_known_bot(login)
        or is_known_bot(name)
        or is_twitch_event_notice(body, tags)
        or is_low_quality(body, normalized, emote_tag)
        or bool(_URL.search(body))
    )


def parse_irc_message(raw: str, *, now_ms: float | None = None) -> Message | None:
    priv = raw.find(" PRIVMSG ")
    body_at = raw.find(" :", priv + 9)
    if priv < 0 or body_at < 0:
        return None
    first_space = raw.find(" ")
    tag_text = raw[1:first_space] if raw.startswith("@") and first_space >= 0 else ""
    tags: dict[str, object] = {}
    for tag in filter(None, tag_text.split(";")):
        key, separator, value = tag.partition("=")
        tags[key] = unescape_irc_tag(value) if separator else ""

    login_start = raw.find(":") + 1
    login_end = raw.find("!", login_start)
    login = raw[login_start:login_end] if login_end >= 0 else ""
    name_value = tags.get("display-name") or login
    name = name_value if isinstance(name_value, str) else ""
    body = utf16_slice(raw[body_at + 2 :].strip(), 0, 500)
    normalized = normalize_message(body)
    emote_value = tags.get("emotes")
    emote_tag = emote_value if isinstance(emote_value, str) else ""
    message_id = _string(tags.get("id"))
    user_id = _string(tags.get("user-id"))
    room_id = _string(tags.get("room-id"))
    timestamp_value = tags.get("tmi-sent-ts")
    try:
        sent_at = _number(timestamp_value, now_ms or time.time() * 1000)
    except (TypeError, ValueError):
        return None
    if not _valid_message(
        message_id=message_id,
        user_id=user_id,
        name=name,
        body=body,
        normalized=normalized,
        login=login,
        tags=tags,
        emote_tag=emote_tag,
        sent_at=sent_at,
    ):
        return None
    badges = _badges(tags)
    return Message(
        id=message_id,
        user_id=user_id,
        room_id=room_id,
        name=name,
        body=body,
        normalized=normalized,
        emotes=parse_twitch_emotes(emote_tag, utf16_length(body)),
        sent_at=sent_at,
        sub=_has_badge(badges, "subscriber"),
        vip=_has_badge(badges, "vip"),
        mod=_has_badge(badges, "moderator"),
    )


def _parse_iso_timestamp(value: str) -> float:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.timestamp() * 1000


def parse_historical_message(raw: Mapping[str, Any]) -> Message | None:
    raw_tags = raw.get("tags")
    tags: dict[str, object] = (
        {str(key): value for key, value in raw_tags.items()}
        if isinstance(raw_tags, Mapping)
        else {}
    )
    text_value = raw.get("text")
    body = utf16_slice(text_value.strip(), 0, 500) if isinstance(text_value, str) else ""
    display_name = raw.get("displayName")
    tag_name = tags.get("display-name")
    name = (
        display_name
        if isinstance(display_name, str)
        else tag_name
        if isinstance(tag_name, str)
        else ""
    )
    raw_id = raw.get("id")
    tag_id = tags.get("id")
    message_id = raw_id if isinstance(raw_id, str) else tag_id if isinstance(tag_id, str) else ""
    user_id = _string(tags.get("user-id"))
    room_id = _string(tags.get("room-id"))
    timestamp = raw.get("timestamp")
    try:
        sent_at = (
            _parse_iso_timestamp(timestamp)
            if isinstance(timestamp, str)
            else _number(tags.get("tmi-sent-ts"))
        )
    except (TypeError, ValueError, OverflowError):
        return None
    normalized = normalize_message(body)
    emote_tag = _string(tags.get("emotes"))
    if not _valid_message(
        message_id=message_id,
        user_id=user_id,
        name=name,
        body=body,
        normalized=normalized,
        login=name,
        tags=tags,
        emote_tag=emote_tag,
        sent_at=sent_at,
    ):
        return None
    badges = _badges(tags)
    return Message(
        id=message_id,
        user_id=user_id,
        room_id=room_id,
        name=name,
        body=body,
        normalized=normalized,
        emotes=parse_twitch_emotes(emote_tag, utf16_length(body)),
        sent_at=sent_at,
        sub=_has_badge(badges, "subscriber"),
        vip=_has_badge(badges, "vip"),
        mod=_has_badge(badges, "moderator"),
    )
