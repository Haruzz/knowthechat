from __future__ import annotations

from typing import Literal, overload

from domain.rooms import Room, RoomArchiveSettings, RoomError
from room_models import GuessRequest, HistoryRequest, JoinRoomRequest, MatchSettingsRequest
from room_types import CommandResult, LeaveResult, RoomSession, RoomSnapshot, SnapshotAction
from services.rooms import new_player


@overload
def execute_command(
    room: Room, action: Literal["join"], token: str, payload: object, now: int
) -> RoomSession: ...


@overload
def execute_command(
    room: Room, action: Literal["leave"], token: str, payload: object, now: int
) -> LeaveResult: ...


@overload
def execute_command(
    room: Room, action: SnapshotAction, token: str, payload: object, now: int
) -> RoomSnapshot: ...


@overload
def execute_command(
    room: Room, action: str, token: str, payload: object, now: int
) -> CommandResult: ...


def execute_command(
    room: Room, action: str, token: str, payload: object, now: int
) -> CommandResult:
    """Called within the DO's synchronous read/mutate/write section."""
    room.advance(now)
    if action == "join":
        request = JoinRoomRequest.model_validate(payload)
        player, issued_token = new_player(request.name, now)
        room.join(player)
        return {"token": issued_token, "room": room.snapshot(player, now)}

    player = room.authenticate(token)
    # Throttle presence writes for HTTP fallback clients and ordinary actions.
    if now - player.last_seen >= 15_000:
        player.last_seen = now
    if action == "history":
        history = HistoryRequest.model_validate(payload)
        if room.phase not in ("waiting", "finished"):
            raise RoomError("History can be synced between matches.", 409)
        player.seen_message_keys = list(dict.fromkeys(history.seen_message_keys))
        player.history_ready = True
    elif action == "settings":
        room.require_host(player)
        if room.phase not in ("waiting", "finished"):
            raise RoomError("Change match settings between games.", 409)
        settings = MatchSettingsRequest.model_validate(payload)
        if settings.channel != room.channel:
            raise RoomError("Create a new lobby to change channels.", 409)
        room.archive_settings = RoomArchiveSettings(
            settings.range_days, settings.archive_year, settings.chatter_pool
        )
        room.requested_round_count = settings.round_count
        room.deck_needs_refresh = True
    elif action == "start":
        room.start(player, now)
    elif action == "guess":
        guess = GuessRequest.model_validate(payload)
        room.guess(player, guess.round_id, guess.choice, now)
    elif action == "next":
        room.next_round(player, now)
    elif action == "rematch":
        raise RoomError("Fresh chat must be prepared before a rematch.", 409)
    elif action == "leave":
        room.leave(player)
        return {"ok": True}
    elif action != "state":
        raise RoomError("Not found.", 404)
    return room.snapshot(player, now)
