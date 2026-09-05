"""A shared SQLite admission ledger, contacted only at lobby lifecycle boundaries."""

from __future__ import annotations

import json
import re
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from typing import TYPE_CHECKING, Annotated, Literal, NotRequired, Protocol, TypedDict, cast

from pydantic import ConfigDict, Field, TypeAdapter, ValidationError, with_config
from workers import DurableObject

from domain.admission import (
    DAY_MS,
    MINUTE_MS,
    PENDING_LEASE_MS,
    AdmissionSettings,
    Reservation,
    retry_seconds,
)
from domain.rooms import ROOM_LIFETIME_MS, RoomError
from runtime.bindings import RoomStorage, SqlValue
from services.rooms import now_ms

if TYPE_CHECKING:
    from js import DurableObjectState, Env  # pyright: ignore[reportMissingModuleSource]

CREATOR_KEY_PATTERN = re.compile(r"[0-9a-f]{64}")
LEASE_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{32}")
UNAVAILABLE = "Lobbies are temporarily unavailable. Please try again."


class AdmissionStub(Protocol):
    def reserve(self, creator_key: str) -> Awaitable[str]: ...

    def activate(self, lease_id: str, expires_at: int) -> Awaitable[str]: ...

    def release(self, lease_id: str) -> Awaitable[str]: ...

    def admit_match(self, lease_id: str, match_number: int) -> Awaitable[str]: ...


class AdmissionNamespace(Protocol):
    def getByName(self, name: str) -> AdmissionStub: ...


class AdmissionEnvironment(Protocol):
    @property
    def ROOM_ADMISSION(self) -> AdmissionNamespace: ...


@with_config(ConfigDict(strict=True, extra="forbid"))
class AdmissionSuccessEnvelope(TypedDict):
    result: Reservation | None


@with_config(ConfigDict(strict=True, extra="forbid"))
class AdmissionErrorEnvelope(TypedDict):
    error: Annotated[str, Field(min_length=1, max_length=256)]
    status: Annotated[int, Field(ge=400, le=599)]
    retryAfter: NotRequired[Annotated[int, Field(ge=1, le=86_400)]]


ENVELOPE_ADAPTER = TypeAdapter(AdmissionSuccessEnvelope | AdmissionErrorEnvelope)


def decode_admission(value: str) -> Reservation | None:
    try:
        if len(value) > 2_048:
            raise ValueError("Oversized admission response")
        envelope = ENVELOPE_ADAPTER.validate_json(value)
        if "error" in envelope:
            raise RoomError(
                envelope["error"], envelope["status"], retry_after=envelope.get("retryAfter")
            )
        result = envelope["result"]
        if result is not None and (
            not LEASE_ID_PATTERN.fullmatch(result.id) or result.expires_at <= 0
        ):
            raise ValueError("Invalid reservation")
        return result
    except (ValidationError, ValueError, TypeError) as error:
        raise RoomError(UNAVAILABLE, 503) from error


class CloudflareAdmissionGateway:
    def __init__(self, namespace: AdmissionNamespace) -> None:
        self.namespace = namespace

    async def _call(self, invoke: Callable[[AdmissionStub], Awaitable[str]]) -> Reservation | None:
        try:
            response = await invoke(self.namespace.getByName("lobbies"))
        except Exception as error:
            # A failed check never becomes permission to start expensive work.
            raise RoomError(UNAVAILABLE, 503) from error
        return decode_admission(response)

    async def reserve(self, creator_key: str) -> Reservation:
        result = await self._call(lambda stub: stub.reserve(creator_key))
        if result is None:
            raise RoomError(UNAVAILABLE, 503)
        return result

    async def activate(self, lease_id: str, expires_at: int) -> None:
        result = await self._call(lambda stub: stub.activate(lease_id, expires_at))
        if result is not None:
            raise RoomError(UNAVAILABLE, 503)

    async def release(self, lease_id: str) -> None:
        result = await self._call(lambda stub: stub.release(lease_id))
        if result is not None:
            raise RoomError(UNAVAILABLE, 503)

    async def admit_match(self, lease_id: str, match_number: int) -> None:
        result = await self._call(lambda stub: stub.admit_match(lease_id, match_number))
        if result is not None:
            raise RoomError(UNAVAILABLE, 503)


class RoomAdmission(DurableObject):
    """Persist admission decisions, with no server timers or per-guess coordination.

    Each check and its writes run synchronously before the first await. SQLite
    implicit transactions and the DO's input/output gates serialize reservations.
    Short leases recover incomplete preparations; alarms prune all retained data.
    """

    def __init__(self, ctx: DurableObjectState[object], env: Env) -> None:
        super().__init__(ctx, env)
        self.settings = AdmissionSettings.from_env(env)
        self.storage = cast(RoomStorage, self.ctx.storage)
        self._schema()

    def _schema(self) -> None:
        statements = (
            "CREATE TABLE IF NOT EXISTS admission_leases ("
            "id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, active INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS admission_lease_expiry ON admission_leases(expires_at)",
            "CREATE TABLE IF NOT EXISTS admission_preparations ("
            "id TEXT PRIMARY KEY, admitted_at INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS admission_preparation_time "
            "ON admission_preparations(admitted_at)",
            "CREATE TABLE IF NOT EXISTS admission_creations ("
            "id TEXT PRIMARY KEY, creator_key TEXT NOT NULL, admitted_at INTEGER NOT NULL)",
            "CREATE INDEX IF NOT EXISTS admission_creation_time "
            "ON admission_creations(admitted_at)",
            "CREATE INDEX IF NOT EXISTS admission_creation_key "
            "ON admission_creations(creator_key, admitted_at)",
            "CREATE TABLE IF NOT EXISTS admission_matches ("
            "lease_id TEXT NOT NULL, match_number INTEGER NOT NULL, admitted_at INTEGER NOT NULL, "
            "PRIMARY KEY (lease_id, match_number))",
            "CREATE INDEX IF NOT EXISTS admission_match_time ON admission_matches(admitted_at)",
        )
        for statement in statements:
            self.storage.sql.exec(statement)

    def _prune(self, now: int) -> None:
        self.storage.sql.exec("DELETE FROM admission_leases WHERE expires_at <= ?", now)
        self.storage.sql.exec(
            "DELETE FROM admission_preparations WHERE admitted_at <= ?", now - DAY_MS
        )
        self.storage.sql.exec("DELETE FROM admission_matches WHERE admitted_at <= ?", now - DAY_MS)
        # Network keys exist only in this minute-long table, never in daily rows.
        self.storage.sql.exec(
            "DELETE FROM admission_creations WHERE admitted_at <= ?", now - MINUTE_MS
        )

    def _integer(self, query: str, *bindings: SqlValue) -> int | None:
        value = self.storage.sql.exec(query, *bindings).toArray()[0]["value"]
        if value is None:
            return None
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError("Invalid admission storage value")
        return value

    async def _schedule(self) -> None:
        next_at = self._integer(
            "SELECT MIN(event_at) AS value FROM ("
            "SELECT MIN(expires_at) AS event_at FROM admission_leases UNION ALL "
            "SELECT MIN(admitted_at) + ? FROM admission_preparations UNION ALL "
            "SELECT MIN(admitted_at) + ? FROM admission_matches UNION ALL "
            "SELECT MIN(admitted_at) + ? FROM admission_creations)",
            DAY_MS,
            DAY_MS,
            MINUTE_MS,
        )
        if next_at is None:
            # Keep the tiny schema; deleting the alarm avoids recurring idle work.
            await cast(AdmissionAlarmStorage, self.storage).deleteAlarm()
        else:
            await self.storage.setAlarm(next_at)

    async def _invoke(self, operation: Callable[[int], Reservation | None]) -> str:
        now = now_ms()
        self._prune(now)
        try:
            result = operation(now)
            response = json.dumps({"result": asdict(result) if result is not None else None})
        except RoomError as error:
            failure: AdmissionErrorEnvelope = {"error": str(error), "status": error.status}
            if error.retry_after is not None:
                failure["retryAfter"] = error.retry_after
            response = json.dumps(failure)
        # No await occurs between capacity checks, counters and lease writes.
        await self._schedule()
        return response

    def _reserve(self, creator_key: str, now: int) -> Reservation:
        if not isinstance(creator_key, str) or not CREATOR_KEY_PATTERN.fullmatch(creator_key):
            raise RoomError("Invalid lobby creation request.")
        recent = self._integer(
            "SELECT COUNT(*) AS value FROM admission_creations WHERE creator_key = ?",
            creator_key,
        )
        if recent is not None and recent >= self.settings.creations_per_minute:
            oldest = self._integer(
                "SELECT MIN(admitted_at) AS value FROM admission_creations WHERE creator_key = ?",
                creator_key,
            )
            raise RoomError(
                "Please wait a moment before creating another lobby.",
                429,
                retry_after=retry_seconds((oldest if oldest is not None else now) + MINUTE_MS, now),
            )
        self._daily_limit("preparations", self.settings.preparations_per_day, now)
        open_count = self._integer("SELECT COUNT(*) AS value FROM admission_leases")
        if open_count is not None and open_count >= self.settings.max_open:
            raise RoomError("All rooms are busy. Please try again shortly.", 429, retry_after=15)
        lease = Reservation(secrets.token_urlsafe(24), now + PENDING_LEASE_MS)
        self.storage.sql.exec(
            "INSERT INTO admission_leases (id, expires_at, active) VALUES (?, ?, 0)",
            lease.id,
            lease.expires_at,
        )
        self.storage.sql.exec(
            "INSERT INTO admission_preparations (id, admitted_at) VALUES (?, ?)", lease.id, now
        )
        self.storage.sql.exec(
            "INSERT INTO admission_creations (id, creator_key, admitted_at) VALUES (?, ?, ?)",
            lease.id,
            creator_key,
            now,
        )
        return lease

    def _daily_limit(self, kind: Literal["preparations", "matches"], limit: int, now: int) -> None:
        # Table identifiers are selected only by internal code; values stay bound.
        table = "admission_preparations" if kind == "preparations" else "admission_matches"
        count = self._integer(f"SELECT COUNT(*) AS value FROM {table}")
        if count is not None and count >= limit:
            oldest = self._integer(f"SELECT MIN(admitted_at) AS value FROM {table}")
            noun = "room" if kind == "preparations" else "match"
            raise RoomError(
                f"The daily {noun} limit has been reached. Please try again later.",
                429,
                retry_after=retry_seconds((oldest if oldest is not None else now) + DAY_MS, now),
            )

    def _lease(self, lease_id: str) -> dict[str, SqlValue]:
        if not isinstance(lease_id, str) or not LEASE_ID_PATTERN.fullmatch(lease_id):
            raise RoomError("Invalid lobby reservation.", 409)
        rows = self.storage.sql.exec(
            "SELECT expires_at, active FROM admission_leases WHERE id = ?", lease_id
        ).toArray()
        if not rows:
            raise RoomError("Your lobby reservation expired. Create a new lobby.", 409)
        return rows[0]

    def _activate(self, lease_id: str, expires_at: int, now: int) -> None:
        lease = self._lease(lease_id)
        if not isinstance(expires_at, int) or isinstance(expires_at, bool):
            raise RoomError("Invalid lobby expiry.")
        if lease["active"] == 1:
            # An ambiguous RPC retry may confirm activation but cannot extend it.
            return
        if not now < expires_at <= now + ROOM_LIFETIME_MS:
            raise RoomError("Invalid lobby expiry.")
        self.storage.sql.exec(
            "UPDATE admission_leases SET active = 1, expires_at = ? WHERE id = ?",
            expires_at,
            lease_id,
        )

    def _release(self, lease_id: str) -> None:
        if not isinstance(lease_id, str) or not LEASE_ID_PATTERN.fullmatch(lease_id):
            raise RoomError("Invalid lobby reservation.", 409)
        # Preparation and match counters remain charged after release or failure.
        self.storage.sql.exec("DELETE FROM admission_leases WHERE id = ?", lease_id)

    def _admit_match(self, lease_id: str, match_number: int, now: int) -> None:
        lease = self._lease(lease_id)
        if lease["active"] != 1:
            raise RoomError("The lobby is still being prepared. Please try again.", 409)
        if (
            not isinstance(match_number, int)
            or isinstance(match_number, bool)
            or not 0 <= match_number <= 2_147_483_647
        ):
            raise RoomError("Invalid match number.")
        existing = self.storage.sql.exec(
            "SELECT 1 FROM admission_matches WHERE lease_id = ? AND match_number = ?",
            lease_id,
            match_number,
        ).toArray()
        if existing:
            return
        self._daily_limit("matches", self.settings.matches_per_day, now)
        self.storage.sql.exec(
            "INSERT INTO admission_matches (lease_id, match_number, admitted_at) VALUES (?, ?, ?)",
            lease_id,
            match_number,
            now,
        )

    async def reserve(self, creator_key: str) -> str:
        return await self._invoke(lambda now: self._reserve(creator_key, now))

    async def activate(self, lease_id: str, expires_at: int) -> str:
        return await self._invoke(lambda now: self._activate(lease_id, expires_at, now))

    async def release(self, lease_id: str) -> str:
        return await self._invoke(lambda _now: self._release(lease_id))

    async def admit_match(self, lease_id: str, match_number: int) -> str:
        return await self._invoke(lambda now: self._admit_match(lease_id, match_number, now))

    async def alarm(self, _alarm_info: object = None) -> None:
        self._prune(now_ms())
        await self._schedule()


class AdmissionAlarmStorage(Protocol):
    def deleteAlarm(self) -> Awaitable[None]: ...
