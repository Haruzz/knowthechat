from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from pydantic import TypeAdapter

from api_models import PublicArchiveRequest, PublicArchiveResponse
from domain.admission import AdmissionGateway
from domain.filtering import contains_excluded_chatter, is_excluded_chatter
from domain.rooms import (
    ROOM_LIFETIME_MS,
    GameRound,
    Player,
    Room,
    RoomArchiveSettings,
    RoomError,
    message_history_key,
    quote_key,
    token_hash,
)
from room_models import CreateRoomRequest
from room_types import (
    CommandPayload,
    EmoteSnapshot,
    ErrorEnvelope,
    RoomResult,
    RoomSession,
    SuccessEnvelope,
)
from services.public_archive import FreshArchiveRequest

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


def build_rounds(
    archive: PublicArchiveResponse,
    round_count: int,
    excluded: set[str] | None = None,
    seen_message_keys: set[str] | None = None,
) -> list[GameRound]:
    names = list(
        dict.fromkeys(
            chatter.name for chatter in archive.chatters if not is_excluded_chatter(chatter.name)
        )
    )
    seen = set(excluded or ())
    quotes = []
    for quote in archive.quotes:
        key = quote_key(quote.text)
        if (
            quote.author in names
            and not contains_excluded_chatter(quote.text)
            and key not in seen
            and message_history_key(quote.id) not in (seen_message_keys or set())
        ):
            quotes.append(quote)
            seen.add(key)
    if len(names) < 3 or len(quotes) < round_count:
        raise RoomError(
            (
                "Not enough fresh chat for everyone. Choose fewer rounds or a wider archive period."
                if excluded is not None or seen_message_keys
                else "Not enough chat for this match. Try another channel, period, or fewer rounds."
            ),
            422,
        )
    rng = secrets.SystemRandom()
    rounds: list[GameRound] = []
    for quote in rng.sample(quotes, round_count):
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
                history_key=message_history_key(quote.id),
            )
        )
    return rounds


async def fresh_rounds(
    room: Room, archive: ArchiveService, *, starting: bool = False
) -> list[GameRound]:
    settings = room.archive_settings
    if settings is None:
        raise RoomError("Create a new lobby to fetch fresh chat for rematches.", 409)
    excluded = set(room.used_quote_keys)
    if not starting:
        excluded.update(quote_key(item.text) for item in room.rounds)
    seen = room.seen_message_keys()
    count = room.requested_round_count or len(room.rounds)
    response = await archive.execute(
        FreshArchiveRequest(
            channel=room.channel,
            rangeDays=settings.range_days,
            archiveYear=settings.archive_year,
            chatterPool=settings.chatter_pool,
            seen_message_keys=frozenset(seen),
            excluded_quote_keys=frozenset(excluded),
            required_quotes=count,
        )
    )
    if response.channel != room.channel:
        raise RoomError("Fresh chat could not be loaded. Please try again.", 503, 15)
    return build_rounds(response, count, excluded, seen)


@dataclass(slots=True)
class RoomPreparation:
    admission_id: str
    initialization_started: bool = False


class RoomService:
    def __init__(
        self,
        archive: ArchiveService,
        gateway: RoomGateway,
        clock: Callable[[], int] = now_ms,
        *,
        admission: AdmissionGateway,
    ) -> None:
        self.archive = archive
        self.gateway = gateway
        self.clock = clock
        self.admission = admission

    async def create(self, request: CreateRoomRequest, creator_key: str) -> RoomSession:
        reservation = await self.admission.reserve(creator_key)
        preparation = RoomPreparation(reservation.id)
        try:
            # Stay inside the admission controller's 120s preparation lease.
            async with asyncio.timeout(90):
                archive = await self.archive.execute(
                    FreshArchiveRequest(
                        **request.archive_request().model_dump(),
                        seen_message_keys=frozenset(request.seen_message_keys),
                        required_quotes=request.round_count,
                    )
                )
            return await self._initialize(request, archive, preparation)
        except TimeoutError:
            raise RoomError(
                "Chat preparation took too long. Please try again shortly.", 503, 15
            ) from None
        finally:
            # An interrupted initialize may already have committed a live room.
            # Its lease must survive until room cleanup or expiry to avoid overbooking.
            if not preparation.initialization_started:
                try:
                    await self.admission.release(reservation.id)
                except Exception:
                    # The short preparation lease also expires after a crash/outage.
                    pass

    async def _initialize(
        self,
        request: CreateRoomRequest,
        archive: PublicArchiveResponse,
        preparation: RoomPreparation,
    ) -> RoomSession:
        rounds = build_rounds(
            archive, request.round_count, seen_message_keys=set(request.seen_message_keys)
        )
        now = self.clock()
        player, token = new_player(request.name, now)
        player.seen_message_keys = request.seen_message_keys
        player.history_ready = True
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
                admission_id=preparation.admission_id,
                archive_settings=RoomArchiveSettings(
                    request.range_days, request.archive_year, request.chatter_pool
                ),
                shared_history=True,
                requested_round_count=request.round_count,
            )
            state = room.to_json()
            if len(state.encode()) > MAX_ROOM_STATE_BYTES:
                raise RoomError("This chat is too large for a lobby. Try fewer rounds.", 422)
            preparation.initialization_started = True
            try:
                await self.gateway.initialize(code, state)
            except RoomError as error:
                if error.status == 409:
                    preparation.initialization_started = False
                    continue
                raise
            return {"token": token, "room": room.snapshot(player, now)}
        raise RoomError("Could not create a lobby. Please try again.", 503)


def result_json(result: RoomResult | None = None, error: RoomError | None = None) -> str:
    if error is not None:
        envelope: ErrorEnvelope = {"error": str(error), "status": error.status}
        if error.retry_after is not None:
            envelope["retryAfter"] = error.retry_after
        return json.dumps(envelope)
    return json.dumps({"result": result or {}}, separators=(",", ":"))


RESULT_ADAPTER = TypeAdapter(SuccessEnvelope | ErrorEnvelope)


def decode_result(value: str) -> RoomResult:
    # RPC returns JSON from a separate runtime boundary. Validate it once rather
    # than letting json.loads' Any escape into every caller.
    envelope = RESULT_ADAPTER.validate_json(value)
    if "error" in envelope:
        raise RoomError(envelope["error"], envelope["status"], envelope.get("retryAfter"))
    return envelope["result"]
