from __future__ import annotations

import re

from domain.text import meaningful_character_count, normalize_message, without_twitch_emotes

KNOWN_BOTS = frozenset(
    {
        "streamelements",
        "nightbot",
        "moobot",
        "fossabot",
        "streamlabs",
        "streamlabscloudbot",
        "wizebot",
        "botrixoficial",
        "serybot",
        "stayhydratedbot",
        "soundalerts",
        "commanderroot",
        "pokemoncommunitygame",
        "own3d",
        "kofistreambot",
        "pretzelrocks",
        "songlistbot",
    }
)
TWITCH_EVENT_IDS = frozenset(
    {
        "sub",
        "resub",
        "subgift",
        "anonsubgift",
        "submysterygift",
        "anonsubmysterygift",
        "giftpaidupgrade",
        "primepaidupgrade",
        "standardpayforward",
        "communitypayforward",
        "raid",
        "unraid",
        "ritual",
        "bitsbadgetier",
        "charitydonation",
    }
)

_GENERIC = re.compile(
    r"^(lol|lmao|lmfao|yes|no|true|based|nice|what|why|wtf|hello|hi|hey|bye|"
    r"good morning|good night|dont say that|do not say that)$",
    re.IGNORECASE,
)
_COMMAND = re.compile(r"^\s*[!/$?.][a-z0-9_]+(?:\s|$)", re.IGNORECASE)
_MENTION = re.compile(r"@[a-z0-9_]{2,25}", re.IGNORECASE)
_RANK_CARD = re.compile(
    r"\b(?:iron|bronze|silver|gold|platinum|emerald|diamond|master|grandmaster|"
    r"challenger)\s+\d+\s*lp\b|\bpros?\s*/\s*streamers?\s*:",
    re.IGNORECASE,
)
_ROSTER_ENTRY = re.compile(r"[^\W\d_][\w]{1,24}\s*\([^)]{2,30}\)", re.UNICODE)
_AUTOMATED = re.compile(
    r"\b(points?|watch\s*time|uptime|has been following|now have \d+|"
    r"ranked? #?\d+|game results?|now playing|current song|followage|account age|"
    r"match history)\b",
    re.IGNORECASE,
)
_STAT = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:%|k)?\s*(?:kp|dmg|cs/min|gold/min|vision/min|"
    r"cc/min|self-mitigated/min)\b",
    re.IGNORECASE,
)
_NOTICE = re.compile(
    r"\b(?:gifted (?:an? |\d+ )?(?:tier \d+ )?subs?|is gifting \d+|"
    r"shared (?:their|an?) resub|subscribed at tier|months? in a row|"
    r"continuing the gift sub|raided with \d+ viewers?)\b",
    re.IGNORECASE,
)
_REPEATED = re.compile(r"(.)\1{5,}", re.IGNORECASE)


def is_known_bot(name: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", name.lower())
    return normalized in KNOWN_BOTS or normalized.endswith(("bot", "botat"))


def is_twitch_event_notice(body: str, tags: dict[str, object]) -> bool:
    raw_message_id = tags.get("msg-id")
    raw_system_message = tags.get("system-msg")
    message_id = raw_message_id.lower() if isinstance(raw_message_id, str) else ""
    system_message = raw_system_message.strip() if isinstance(raw_system_message, str) else ""
    return message_id in TWITCH_EVENT_IDS or bool(system_message) or bool(_NOTICE.search(body))


def is_low_quality(body: str, normalized: str, emote_tag: str = "") -> bool:
    prose = normalize_message(without_twitch_emotes(body, emote_tag))
    words = [word for word in prose.split(" ") if word]
    pipes = body.count("|")
    roster_entries = len(_ROSTER_ENTRY.findall(body))
    automated = (
        bool(_AUTOMATED.search(body))
        or pipes >= 4
        or bool(_RANK_CARD.search(body))
        or (pipes >= 2 and roster_entries >= 2)
        or bool(_STAT.search(body))
    )
    meaningful = meaningful_character_count(body) / max(len(body), 1)
    return (
        bool(_COMMAND.search(body))
        or bool(_GENERIC.fullmatch(normalized))
        or bool(_MENTION.search(body))
        or automated
        or len(words) < 4
        or bool(_REPEATED.search(body))
        or meaningful < 0.45
    )
