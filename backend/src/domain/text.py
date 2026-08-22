from __future__ import annotations

import re
import unicodedata

from domain.models import EmoteSpan

_WHITESPACE = re.compile(r"\s+")
_EMOTE_RANGE = re.compile(r"(\d+)-(\d+)")


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def utf16_slice(value: str, start: int, end: int | None = None) -> str:
    encoded = value.encode("utf-16-le", errors="surrogatepass")
    stop = len(encoded) if end is None else max(0, end) * 2
    return encoded[max(0, start) * 2 : stop].decode("utf-16-le", errors="surrogatepass")


def normalize_message(body: str) -> str:
    lowered = body.lower()
    kept = "".join(
        character
        for character in lowered
        if character.isspace() or unicodedata.category(character).startswith(("L", "N"))
    )
    return _WHITESPACE.sub(" ", kept).strip()


def meaningful_character_count(body: str) -> int:
    return sum(unicodedata.category(character).startswith(("L", "N")) for character in body)


def parse_twitch_emotes(
    emote_tag: str = "", body_length: int | float = float("inf")
) -> tuple[EmoteSpan, ...]:
    emotes: list[EmoteSpan] = []
    for group in emote_tag.split("/"):
        emote_id, separator, positions = group.partition(":")
        if not separator or not emote_id.isascii() or not emote_id.isdigit():
            continue
        for position in positions.split(","):
            match = re.fullmatch(r"(\d+)-(\d+)", position)
            if not match:
                continue
            start, end = (int(part) for part in match.groups())
            if 0 <= start <= end < body_length:
                emotes.append(EmoteSpan(emote_id, start, end))
    return tuple(sorted(emotes, key=lambda emote: emote.start))


def without_twitch_emotes(body: str, emote_tag: str = "") -> str:
    encoded = bytearray(body.encode("utf-16-le", errors="surrogatepass"))
    ranges = sorted(
        ((int(match[1]), int(match[2])) for match in _EMOTE_RANGE.finditer(emote_tag)),
        reverse=True,
    )
    for start, end in ranges:
        byte_start = max(0, start * 2)
        byte_end = min(len(encoded), (end + 1) * 2)
        encoded[byte_start:byte_end] = " ".encode("utf-16-le")
    return encoded.decode("utf-16-le", errors="surrogatepass")


def add_third_party_spans(
    body: str,
    native: tuple[EmoteSpan, ...],
    catalog: dict[str, str],
) -> tuple[EmoteSpan, ...]:
    spans = list(native)
    for match in re.finditer(r"\S+", body):
        raw = match.group(0)
        url = catalog.get(raw)
        if not url:
            continue
        start = utf16_length(body[: match.start()])
        end = start + utf16_length(raw) - 1
        if any(start <= span.end and end >= span.start for span in spans):
            continue
        spans.append(EmoteSpan(f"third-party:{raw}", start, end, url))
    return tuple(sorted(spans, key=lambda emote: emote.start))
