"""Shared room payload shapes; these describe the existing JSON wire format."""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict, TypeGuard

from pydantic import ConfigDict, with_config

Phase = Literal["waiting", "round", "reveal", "finished"]
Difficulty = Literal["easy", "medium", "hard"]
SnapshotAction = Literal["state", "start", "guess", "next", "rematch", "history", "settings"]
CommandAction = SnapshotAction | Literal["join", "leave"]


class EmoteSnapshot(TypedDict):
    id: str
    start: int
    end: int
    url: NotRequired[str]


class RoundSnapshot(TypedDict):
    historyKey: NotRequired[str]
    id: str
    text: str
    emotes: list[EmoteSnapshot]
    sentAt: float
    difficulty: Difficulty
    choices: list[str]
    author: NotRequired[str]


class PlayerSnapshot(TypedDict):
    id: str
    name: str
    score: int
    streak: int
    bestStreak: int
    answered: bool
    choice: str | None
    roundPoints: int


class MatchSettings(TypedDict):
    roundCount: int
    archiveYear: int | None
    rangeDays: float | None
    chatterPool: int


class RoomSnapshot(TypedDict):
    historyRequired: NotRequired[bool]
    historiesReady: NotRequired[bool]
    matchSettings: NotRequired[MatchSettings]
    code: str
    revision: int
    channel: str
    phase: Phase
    hostId: str
    you: str
    players: list[PlayerSnapshot]
    roundNumber: int
    totalRounds: int
    roundSeconds: int
    deadline: int | None
    serverNow: int
    round: RoundSnapshot | None
    expiresAt: int


class RoomSession(TypedDict):
    token: str
    room: RoomSnapshot


class LeaveResult(TypedDict):
    ok: Literal[True]


@with_config(ConfigDict(extra="forbid"))
class EmptyResult(TypedDict):
    """Only initialization returns an empty successful result."""


class JoinPayload(TypedDict):
    name: str


class GuessPayload(TypedDict):
    roundId: str
    choice: str


class EmptyPayload(TypedDict):
    pass


class HistoryPayload(TypedDict):
    seenMessageKeys: list[str]


class SettingsPayload(TypedDict):
    channel: str
    roundCount: int
    archiveYear: int | None
    rangeDays: float | None
    chatterPool: int


CommandPayload = JoinPayload | GuessPayload | EmptyPayload | HistoryPayload | SettingsPayload
CommandResult = RoomSnapshot | RoomSession | LeaveResult
RoomResult = CommandResult | EmptyResult


class SuccessEnvelope(TypedDict):
    result: RoomResult


class ErrorEnvelope(TypedDict):
    error: str
    status: int
    retryAfter: NotRequired[int]


def is_room_session(result: RoomResult) -> TypeGuard[RoomSession]:
    return "token" in result and "room" in result


def is_room_snapshot(result: RoomResult) -> TypeGuard[RoomSnapshot]:
    return "code" in result and "players" in result


def snapshot_from_result(result: RoomResult) -> RoomSnapshot | None:
    """Return the original snapshot so committed revisions update the outgoing payload."""
    if is_room_session(result):
        return result["room"]
    if is_room_snapshot(result):
        return result
    return None
