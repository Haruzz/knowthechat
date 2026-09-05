"""Exercise the actual runtime adapter with real SQLite and a tiny platform boundary fake."""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest
from test_rooms import NOW, FakeAdmission, FakeArchive, make_room

from domain.rooms import ROOM_LIFETIME_MS, Room, RoomError


class SqlCursor:
    def __init__(self, cursor: sqlite3.Cursor) -> None:
        self.cursor = cursor

    def toArray(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.cursor.fetchall()]


class Storage:
    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.sql = self
        self.alarm_at: int | None = None
        self.deletions = 0
        self.writes = 0

    def exec(self, statement: str, *bindings: Any) -> SqlCursor:
        if statement.startswith(("CREATE", "INSERT")):
            self.writes += 1
        return SqlCursor(self.db.execute(statement, bindings))

    async def setAlarm(self, alarm_at: int) -> None:
        self.alarm_at = alarm_at

    async def deleteAll(self) -> None:
        self.db.execute("DROP TABLE IF EXISTS room_state")
        self.alarm_at = None
        self.deletions += 1

    async def deleteAlarm(self) -> None:
        raise AssertionError("Cleanup must delete data and alarms in one atomic deleteAll call")


class AdmissionRpc:
    def __init__(self, admission: FakeAdmission) -> None:
        self.admission = admission

    async def _result(self, operation: Any) -> str:
        try:
            await operation
            return '{"result":null}'
        except RoomError as error:
            result: dict[str, str | int] = {"error": str(error), "status": error.status}
            if error.retry_after is not None:
                result["retryAfter"] = error.retry_after
            return json.dumps(result)

    async def activate(self, lease_id: str, expires_at: int) -> str:
        return await self._result(self.admission.activate(lease_id, expires_at))

    async def release(self, lease_id: str) -> str:
        return await self._result(self.admission.release(lease_id))

    async def admit_match(self, lease_id: str, match_number: int) -> str:
        return await self._result(self.admission.admit_match(lease_id, match_number))

    async def admit_rematch(self, lease_id: str, attempt_id: str, match_number: int) -> str:
        return await self._result(self.admission.admit_rematch(lease_id, attempt_id, match_number))


class Socket:
    def __init__(self) -> None:
        self.readyState = 1
        self.accepted = False
        self.attachment: str | None = None
        self.messages: list[str] = []
        self.closed: tuple[int, str] | None = None
        self.ping_at: int | None = None
        self.on_send: Callable[[str], None] | None = None

    def accept(self) -> None:
        raise AssertionError("Native accept prevents Durable Object hibernation")

    def addEventListener(self, *_args: Any) -> None:
        raise AssertionError("Hibernating WebSockets use Durable Object handlers")

    def send(self, message: str) -> None:
        assert self.accepted
        assert self.readyState == 1
        if self.on_send is not None:
            self.on_send(message)
        self.messages.append(message)

    def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)
        self.readyState = 3

    def serializeAttachment(self, attachment: str) -> None:
        assert isinstance(attachment, str)
        self.attachment = attachment

    def deserializeAttachment(self) -> str | None:
        return self.attachment


class Context:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage
        self.sockets: list[Socket] = []
        self.auto_response: Any = None

    def acceptWebSocket(self, socket: Socket, _tags: Any = None) -> None:
        socket.accepted = True
        self.sockets.append(socket)

    def getWebSockets(self) -> list[Socket]:
        return [socket for socket in self.sockets if socket.readyState != 3]

    def setWebSocketAutoResponse(self, pair: Any) -> None:
        self.auto_response = pair

    def getWebSocketAutoResponseTimestamp(self, socket: Socket) -> Any:
        return SimpleNamespace(getTime=lambda: socket.ping_at) if socket.ping_at else None


class Response:
    def __init__(
        self,
        body: Any = None,
        status: int = 200,
        headers: dict[str, str] | None = None,
        web_socket: Socket | None = None,
        **_kwargs: Any,
    ) -> None:
        self.body = body
        self.status = status
        self.headers = headers or {}
        self.web_socket = web_socket

    @classmethod
    def from_json(cls, data: Any, **kwargs: Any) -> Response:
        return cls(json.dumps(data), **kwargs)


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Storage]:
    # Workers depends on Pyodide. Fake only the platform APIs; keep real SQLite and room logic.
    class DurableObject:
        def __init__(self, ctx: Any, env: Any) -> None:
            self.ctx = ctx
            self.env = env

    workers = ModuleType("workers")
    workers.DurableObject = DurableObject  # pyright: ignore[reportAttributeAccessIssue]
    workers.Response = Response  # pyright: ignore[reportAttributeAccessIssue]
    workers.Request = Any  # pyright: ignore[reportAttributeAccessIssue]
    monkeypatch.setitem(sys.modules, "workers", workers)
    js = ModuleType("js")
    pairs: list[tuple[Socket, Socket]] = []

    def make_pair() -> Any:
        pair = (Socket(), Socket())
        pairs.append(pair)
        return SimpleNamespace(object_values=lambda: pair)

    js.WebSocketPair = SimpleNamespace(new=make_pair)  # pyright: ignore[reportAttributeAccessIssue]
    js.WebSocketRequestResponsePair = SimpleNamespace(  # pyright: ignore[reportAttributeAccessIssue]
        new=lambda request, response: SimpleNamespace(request=request, response=response)
    )
    monkeypatch.setitem(sys.modules, "js", js)
    path = Path(__file__).parents[1] / "src" / "runtime" / "rooms.py"
    spec = importlib.util.spec_from_file_location("tested_room_runtime", path)
    assert spec is not None and spec.loader is not None
    module: Any = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "now_ms", lambda: NOW)
    storage = Storage()
    module.context = Context(storage)
    module.pairs = pairs
    module.admission = FakeAdmission()
    admission_rpc = AdmissionRpc(module.admission)
    module.env = SimpleNamespace(
        ROOM_ADMISSION=SimpleNamespace(getByName=lambda _name: admission_rpc)
    )
    module.archive = FakeArchive(100)
    monkeypatch.setattr(module.GameRoom, "_archive", lambda self: module.archive)
    module.instance = module.GameRoom(module.context, module.env)
    return module, storage


@pytest.mark.asyncio
async def test_unknown_room_is_read_only_without_storage_or_alarm(
    runtime: tuple[Any, Storage],
) -> None:
    module, storage = runtime
    response = json.loads(await module.instance.command("state", "unused", "{}"))
    assert response["status"] == 404
    assert storage.writes == 0
    assert storage.alarm_at is None
    assert storage.deletions == 0


@pytest.mark.asyncio
async def test_expiry_and_last_leave_atomically_clear_data_and_alarms(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    room, host_token, guest_token = make_room()
    await module.instance.initialize(room.to_json())
    assert storage.alarm_at is not None
    await module.instance.command("leave", guest_token, "{}")
    assert json.loads(await module.instance.command("leave", host_token, "{}"))["result"] == {
        "ok": True
    }
    assert storage.deletions == 1
    assert storage.alarm_at is None
    assert module.instance._load() is None
    await module.instance.initialize(room.to_json())
    monkeypatch.setattr(module, "now_ms", lambda: NOW + ROOM_LIFETIME_MS)
    response = json.loads(await module.instance.command("join", "", '{"name":"Late"}'))
    assert response["status"] == 404
    assert storage.deletions == 2
    assert storage.alarm_at is None
    assert module.instance._load() is None


@pytest.mark.asyncio
async def test_alarm_reveals_once_after_reconstruction_and_reschedules_expiry(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    room, host_token, _guest_token = make_room()
    await module.instance.initialize(room.to_json())
    await module.instance.command("start", host_token, "{}")
    await module.instance.command("guess", host_token, '{"roundId":"round-0","choice":"chatter_a"}')
    assert storage.alarm_at == NOW + 20_000
    # A fresh instance has no cached authority but retains the same storage.
    restored = module.GameRoom(module.context, module.env)
    monkeypatch.setattr(module, "now_ms", lambda: NOW + 20_000)
    await restored.alarm()
    state: Room = restored._load()
    assert state.phase == "reveal"
    assert state.players[0].score == 1_500
    assert storage.alarm_at is not None and storage.alarm_at > NOW + 20_000
    await restored.alarm()
    assert restored._load().players[0].score == 1_500


@pytest.mark.asyncio
async def test_late_rejected_guess_still_persists_deadline_transition(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, _storage = runtime
    room, host_token, _guest_token = make_room()
    await module.instance.initialize(room.to_json())
    await module.instance.command("start", host_token, "{}")
    monkeypatch.setattr(module, "now_ms", lambda: NOW + 20_000)
    response = json.loads(
        await module.instance.command(
            "guess", host_token, '{"roundId":"round-0","choice":"chatter_a"}'
        )
    )
    assert response["status"] == 409
    assert module.instance._load().phase == "reveal"
    assert module.instance._load().players[0].score == 0
