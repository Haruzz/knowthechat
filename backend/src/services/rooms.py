from __future__ import annotations

import json
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Protocol

from pydantic import TypeAdapter

from api_models import PublicArchiveRequest, PublicArchiveResponse
from domain.rooms import ROOM_LIFETIME_MS, GameRound, Player, Room, RoomError, token_hash
from room_models import CreateRoomRequest
from room_types import (
    CommandPayload,
    EmoteSnapshot,
    ErrorEnvelope,
    RoomResult,
    RoomSession,
    SuccessEnvelope,
)

ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOM_CODE_PATTERN = re.compile(r"[A-HJ-NP-Z2-9]{6}")
MAX_ROOM_STATE_BYTES = 256_000


class ArchiveService(Protocol):
    async def execute(self, request: PublicArchiveRequest) -> PublicArchiveResponse: ...


class RoomGateway(Protocol):
    async def initialize(self, code: str, state: str) -> None: ...

    async def command(
        self, code: str, action: str, token: str, payload: CommandPayload
    ) -> RoomResult: ...


def now_ms() -> int:
    return int(time.time() * 1_000)


def normalize_code(code: str) -> str:
    code = code.upper()
    if not ROOM_CODE_PATTERN.fullmatch(code):
        raise RoomError("Enter a valid six-character lobby code.")
    return code


def new_player(name: str, now: int) -> tuple[Player, str]:
    token = secrets.token_urlsafe(32)
    return Player(secrets.token_hex(12), name, token_hash(token), now), token


def shuffled_rematch(rounds: list[GameRound]) -> list[GameRound]:
    rng = secrets.SystemRandom()
    reordered = rng.sample(rounds, len(rounds))
    return [
        replace(item, id=secrets.token_hex(12), choices=rng.sample(item.choices, len(item.choices)))
        for item in reordered
    ]


class RoomService:
    def __init__(
        self, archive: ArchiveService, gateway: RoomGateway, clock: Callable[[], int] = now_ms
    ) -> None:
        self.archive = archive
        self.gateway = gateway
        self.clock = clock

    async def create(self, request: CreateRoomRequest) -> RoomSession:
        archive = await self.archive.execute(request.archive_request())
        names = list(dict.fromkeys(chatter.name for chatter in archive.chatters))
        quotes = [quote for quote in archive.quotes if quote.author in names]
        if len(names) < 3 or len(quotes) < request.round_count:
            raise RoomError(
                "Not enough chat for this match. Try another channel, period, or fewer rounds.",
                422,
            )
        rng = secrets.SystemRandom()
        rounds: list[GameRound] = []
        for quote in rng.sample(quotes, request.round_count):
            alternatives = rng.sample([name for name in names if name != quote.author], 2)
            choices = [quote.author, *alternatives]
            rng.shuffle(choices)
            emotes: list[EmoteSnapshot] = []
            for emote in quote.emotes:
                rendered: EmoteSnapshot = {"id": emote.id, "start": emote.start, "end": emote.end}
                if emote.url is not None:
                    rendered["url"] = emote.url
                emotes.append(rendered)
            rounds.append(
                GameRound(
                    id=secrets.token_hex(12),
                    text=quote.text,
                    emotes=emotes,
                    sent_at=quote.sent_at,
                    difficulty=quote.difficulty,
                    choices=choices,
                    author=quote.author,
                )
            )
        now = self.clock()
        player, token = new_player(request.name, now)
        for _attempt in range(4):
            code = "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(6))
            room = Room(
                code=code,
                channel=archive.channel,
                host_id=player.id,
                rounds=rounds,
                round_seconds=request.round_seconds,
                expires_at=now + ROOM_LIFETIME_MS,
                players=[player],
            )
            state = room.to_json()
            if len(state.encode()) > MAX_ROOM_STATE_BYTES:
                raise RoomError("This chat is too large for a lobby. Try fewer rounds.", 422)
            try:
                await self.gateway.initialize(code, state)
            except RoomError as error:
                if error.status == 409:
                    continue
                raise
            return {"token": token, "room": room.snapshot(player, now)}
        raise RoomError("Could not create a lobby. Please try again.", 503)


def result_json(result: RoomResult | None = None, error: RoomError | None = None) -> str:
    if error is not None:
        return json.dumps({"error": str(error), "status": error.status})
    return json.dumps({"result": result or {}}, separators=(",", ":"))


RESULT_ADAPTER = TypeAdapter(SuccessEnvelope | ErrorEnvelope)


def decode_result(value: str) -> RoomResult:
    # RPC returns JSON from a separate runtime boundary. Validate it once rather
    # than letting json.loads' Any escape into every caller.
    envelope = RESULT_ADAPTER.validate_json(value)
    if "error" in envelope:
        raise RoomError(envelope["error"], envelope["status"])
    return envelope["result"]
