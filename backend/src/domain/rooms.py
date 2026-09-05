"""Deterministic multiplayer rules; storage and provider I/O live outside this module."""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import asdict, dataclass, field

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


@dataclass(slots=True)
class GameRound:
    id: str
    text: str
    emotes: list[EmoteSnapshot]
    sent_at: float
    difficulty: Difficulty
    choices: list[str]
    author: str


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
            return
        self.round_index += 1
        self._start_round(now)

    def rematch(self, player: Player, rounds: list[GameRound]) -> None:
        self.require_host(player)
        if self.phase != "finished":
            raise RoomError("Finish this match before a rematch.", 409)
        self.rounds = rounds
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
            if revealed:
                current["author"] = game_round.author
        return {
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


ROOM_ADAPTER = TypeAdapter(Room)
