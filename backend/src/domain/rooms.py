"""Deterministic multiplayer rules; storage and provider I/O live outside this module."""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import asdict, dataclass, field
from typing import Literal

from pydantic import TypeAdapter

from room_types import Difficulty, EmoteSnapshot, Phase, RoomSnapshot, RoundSnapshot

ROOM_LIFETIME_MS = 2 * 60 * 60 * 1_000
PLAYER_IDLE_MS = 15 * 60 * 1_000
MAX_PLAYERS = 8


class RoomError(Exception):
    def __init__(self, message: str, status: int = 400, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass(slots=True)
class Player:
    id: str
    name: str
    token_hash: str
    last_seen: int
    score: int = 0
    streak: int = 0
    best_streak: int = 0
    choice: str | None = None
    pending_points: int = 0
    round_points: int = 0
    seen_message_keys: list[str] = field(default_factory=list)
    history_ready: bool = False


@dataclass(slots=True)
class GameRound:
    id: str
    text: str
    emotes: list[EmoteSnapshot]
    sent_at: float
    difficulty: Difficulty
    choices: list[str]
    author: str
    history_key: str = ""


MAX_QUOTE_HISTORY = 2_000


def message_history_key(message_id: str) -> str:
    return "h:" + hashlib.sha256(message_id.encode()).hexdigest()[:24]


def quote_key(text: str) -> str:
    return hashlib.sha256(" ".join(text.casefold().split()).encode()).hexdigest()


@dataclass(frozen=True, slots=True)
class RoomArchiveSettings:
    range_days: float | None
    archive_year: int | None
    chatter_pool: Literal[25, 50, 100]


@dataclass(slots=True)
class Room:
    code: str
    channel: str
    host_id: str
    rounds: list[GameRound]
    round_seconds: int
    expires_at: int
    players: list[Player] = field(default_factory=list)
    phase: Phase = "waiting"
    round_index: int = -1
    deadline: int | None = None
    revision: int = 0
    admission_id: str = ""
    match_number: int = 0
    archive_settings: RoomArchiveSettings | None = None
    used_quote_keys: list[str] = field(default_factory=list)
    host_seen_message_keys: list[str] = field(default_factory=list)
    shared_history: bool = False
    requested_round_count: int = 0
    deck_needs_refresh: bool = False
    rematch_attempt: str = ""
    rematch_until: int = 0

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"))

    @classmethod
    def from_json(cls, value: str) -> Room:
        # Reconstruct the persisted dataclasses, including defaults for older rooms.
        return ROOM_ADAPTER.validate_json(value)

    def authenticate(self, token: str) -> Player:
        digest = token_hash(token)
        for player in self.players:
            if hmac.compare_digest(player.token_hash, digest):
                return player
        raise RoomError("Your lobby session has expired. Join the lobby again.", 401)

    def require_host(self, player: Player) -> None:
        if player.id != self.host_id:
            raise RoomError("Only the host can do that.", 403)

    def advance(self, now: int) -> bool:
        """Apply server deadlines before processing commands, even if an alarm is delayed."""
        changed = False
        if self.phase == "round" and self.deadline is not None and now >= self.deadline:
            self.reveal()
            changed = True
        active = [player for player in self.players if now - player.last_seen < PLAYER_IDLE_MS]
        if len(active) != len(self.players):
            self.players = active
            self._transfer_host()
            changed = True
            if self.phase == "round" and active and all(p.choice is not None for p in active):
                self.reveal()
        return changed

    def join(self, player: Player) -> None:
        if self.phase != "waiting":
            raise RoomError("This match has already started. Join the next lobby.", 409)
        if len(self.players) >= MAX_PLAYERS:
            raise RoomError(f"This lobby is full ({MAX_PLAYERS} players).", 409)
        if any(p.name.casefold() == player.name.casefold() for p in self.players):
            raise RoomError("That display name is already taken in this lobby.", 409)
        self.players.append(player)
        self._transfer_host()

    def start(self, player: Player, now: int) -> None:
        self.require_host(player)
        if self.phase != "waiting":
            raise RoomError("The match has already started.", 409)
        self._require_players()
        self.require_histories()
        if self.shared_history and (
            self.deck_needs_refresh
            or any(item.history_key in self.seen_message_keys() for item in self.rounds)
        ):
            raise RoomError("Fresh questions must be prepared before starting.", 409)
        self.round_index = 0
        self._start_round(now)

    def guess(self, player: Player, round_id: str, choice: str, now: int) -> None:
        if self.phase != "round" or self.deadline is None or now >= self.deadline:
            raise RoomError("This round is closed.", 409)
        current = self.rounds[self.round_index]
        if current.id != round_id:
            raise RoomError("That guess belongs to a different round.", 409)
        if player.choice is not None:
            raise RoomError("Your answer is already locked in.", 409)
        if choice not in current.choices:
            raise RoomError("Choose one of the three chatters.")
        remaining = min(1.0, max(0.0, (self.deadline - now) / (self.round_seconds * 1_000)))
        player.choice = choice
        player.pending_points = 1_000 + int(500 * remaining) if choice == current.author else 0
        if all(p.choice is not None for p in self.players):
            self.reveal()

    def reveal(self) -> None:
        if self.phase != "round":
            return
        current = self.rounds[self.round_index]
        for player in self.players:
            correct = player.choice == current.author
            player.round_points = player.pending_points
            player.score += player.round_points
            player.streak = player.streak + 1 if correct else 0
            player.best_streak = max(player.best_streak, player.streak)
        self.phase = "reveal"
        self.deadline = None

    def next_round(self, player: Player, now: int) -> None:
        self.require_host(player)
        if self.phase != "reveal":
            raise RoomError("Wait for the round to finish first.", 409)
        if self.round_index + 1 >= len(self.rounds):
            self.phase = "finished"
            if self.shared_history:
                for member in self.players:
                    member.history_ready = False
            return
        self.round_index += 1
        self._start_round(now)

    def rematch(self, player: Player, rounds: list[GameRound]) -> None:
        self.require_host(player)
        if self.phase != "finished":
            raise RoomError("Finish this match before a rematch.", 409)
        history = dict.fromkeys(
            [
                *self.used_quote_keys,
                *(quote_key(item.text) for item in self.rounds),
                *(quote_key(item.text) for item in rounds if not self.shared_history),
            ]
        )
        # Leave room for eight bounded browser histories inside the state-size limit.
        limit = 1_000 if self.shared_history else MAX_QUOTE_HISTORY
        self.used_quote_keys = list(history)[-limit:]
        self.rounds = rounds
        self.deck_needs_refresh = False
        self.rematch_attempt = ""
        self.rematch_until = 0
        self.match_number += 1
        self.phase = "waiting"
        self.round_index = -1
        self.deadline = None
        for member in self.players:
            member.score = 0
            member.streak = 0
            member.best_streak = 0
            member.choice = None
            member.pending_points = 0
            member.round_points = 0

    def leave(self, player: Player) -> None:
        self.players = [member for member in self.players if member.id != player.id]
        self._transfer_host()
        if (
            self.phase == "round"
            and self.players
            and all(p.choice is not None for p in self.players)
        ):
            self.reveal()

    def seen_message_keys(self) -> set[str]:
        return set(self.host_seen_message_keys).union(
            *(set(player.seen_message_keys) for player in self.players)
        )

    def require_histories(self) -> None:
        if self.shared_history and any(not player.history_ready for player in self.players):
            raise RoomError("Waiting for everyone to sync their question history.", 409)

    def preparation_signature(self) -> str:
        # Presence/score updates do not invalidate I/O; membership, history and settings do.
        return json.dumps(
            [
                [(p.id, p.history_ready, sorted(p.seen_message_keys)) for p in self.players],
                asdict(self.archive_settings) if self.archive_settings else None,
                self.requested_round_count,
            ]
        )

    def _require_players(self) -> None:
        if len(self.players) < 2:
            raise RoomError("Invite at least one friend before starting.", 409)

    def _transfer_host(self) -> None:
        if self.players and all(player.id != self.host_id for player in self.players):
            self.host_id = self.players[0].id

    def _start_round(self, now: int) -> None:
        self.phase = "round"
        self.deadline = now + self.round_seconds * 1_000
        for player in self.players:
            player.choice = None
            player.pending_points = 0
            player.round_points = 0

    def snapshot(self, player: Player, now: int) -> RoomSnapshot:
        revealed = self.phase in ("reveal", "finished")
        current: RoundSnapshot | None = None
        if self.round_index >= 0:
            game_round = self.rounds[self.round_index]
            current = {
                "id": game_round.id,
                "text": game_round.text,
                "emotes": game_round.emotes,
                "sentAt": game_round.sent_at,
                "difficulty": game_round.difficulty,
                "choices": game_round.choices,
            }
            if game_round.history_key:
                current["historyKey"] = game_round.history_key
            if revealed:
                current["author"] = game_round.author
        snapshot: RoomSnapshot = {
            "code": self.code,
            "revision": self.revision,
            "channel": self.channel,
            "phase": self.phase,
            "hostId": self.host_id,
            "you": player.id,
            "players": [
                {
                    "id": member.id,
                    "name": member.name,
                    "score": member.score,
                    "streak": member.streak,
                    "bestStreak": member.best_streak,
                    "answered": member.choice is not None,
                    "choice": member.choice if revealed or member.id == player.id else None,
                    "roundPoints": member.round_points if revealed else 0,
                }
                for member in self.players
            ],
            "roundNumber": self.round_index + 1,
            "totalRounds": len(self.rounds),
            "roundSeconds": self.round_seconds,
            "deadline": self.deadline,
            "serverNow": now,
            "round": current,
            "expiresAt": self.expires_at,
        }
        if self.shared_history:
            snapshot["historyRequired"] = not player.history_ready
            snapshot["historiesReady"] = all(p.history_ready for p in self.players)
            if self.archive_settings:
                snapshot["matchSettings"] = {
                    "roundCount": self.requested_round_count or len(self.rounds),
                    "archiveYear": self.archive_settings.archive_year,
                    "rangeDays": self.archive_settings.range_days,
                    "chatterPool": self.archive_settings.chatter_pool,
                }
        return snapshot


ROOM_ADAPTER = TypeAdapter(Room)
