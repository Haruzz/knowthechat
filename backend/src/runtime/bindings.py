"""The Python SDK's view of our bindings after its JavaScript-to-Python conversion.

Generated `js` types describe native APIs. The SDK additionally wraps Durable
Object RPC and SQL results as Python objects; these small interfaces describe
the methods this application uses on those wrappers.
"""

from __future__ import annotations

from collections.abc import Awaitable
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from workers import Request, Response

    from runtime.admission import AdmissionNamespace

type SqlValue = str | int | float | bytes | None


class RoomStub(Protocol):
    def initialize(self, state: str) -> Awaitable[str]: ...

    def command(self, action: str, token: str, payload_json: str) -> Awaitable[str]: ...

    def fetch(self, request: Request) -> Awaitable[Response]: ...


class RoomNamespace(Protocol):
    def getByName(self, name: str) -> RoomStub: ...


class RoomEnvironment(Protocol):
    @property
    def ROOM_ADMISSION(self) -> AdmissionNamespace: ...

    @property
    def GAME_ROOMS(self) -> RoomNamespace: ...


class SqlCursor(Protocol):
    def toArray(self) -> list[dict[str, SqlValue]]: ...


class SqlStorage(Protocol):
    def exec(self, query: str, *bindings: SqlValue) -> SqlCursor: ...


class RoomStorage(Protocol):
    @property
    def sql(self) -> SqlStorage: ...

    def setAlarm(self, scheduled_time: int) -> Awaitable[None]: ...

    def deleteAll(self) -> Awaitable[None]: ...
