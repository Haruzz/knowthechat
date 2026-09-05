"""Exercise authenticated room pushes across the hibernation boundary."""

from __future__ import annotations

import json
from importlib import import_module
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import Headers
from test_room_runtime import Socket, Storage
from test_room_runtime import runtime as runtime
from test_rooms import NOW, make_room

from domain.rooms import PLAYER_IDLE_MS, ROOM_LIFETIME_MS
from services.rooms import new_player


def upgrade(token: str, **headers: str) -> Any:
    return SimpleNamespace(
        method="GET",
        url="https://knowthechat.com/api/rooms/ABC234/events",
        headers=Headers(
            {
                "Upgrade": "websocket",
                "Origin": "https://knowthechat.com",
                "Sec-WebSocket-Protocol": f"knowthechat.v1, session.{token}",
                **headers,
            }
        ),
    )


async def connect(module: Any, token: str) -> Socket:
    response = await module.instance.fetch(upgrade(token))
    assert response.status == 101
    assert Headers(response.headers)["Sec-WebSocket-Protocol"] == "knowthechat.v1"
    assert token not in json.dumps(response.headers)
    client, server = module.pairs[-1]
    assert response.web_socket is client
    assert server.accepted
    return server


def last_room(socket: Socket) -> dict[str, Any]:
    frames = [json.loads(message) for message in socket.messages]
    return [frame["room"] for frame in frames if frame["type"] == "room"][-1]


@pytest.mark.asyncio
async def test_upgrade_authenticates_before_accepting_and_registers_auto_ping(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    room, token, _guest = make_room()
    await module.instance.initialize(room.to_json())
    invalid = [
        upgrade("x" * 43),
        upgrade("short"),
        upgrade(token, **{"Sec-WebSocket-Protocol": "knowthechat.v1"}),
        upgrade(token, **{"Sec-WebSocket-Protocol": f"session.{token}"}),
        upgrade(token, **{"Upgrade": ""}),
    ]
    for request in invalid:
        assert (await module.instance.fetch(request)).status != 101
        assert not module.context.sockets
    bad_origin = upgrade(token, Origin="https://unrelated.example")
    assert (await module.instance.fetch(bad_origin)).status == 403
    assert not module.context.sockets
    socket = await connect(module, token)
    assert socket.attachment == room.host_id
    assert last_room(socket)["you"] == room.host_id
    assert module.context.auto_response.request == "ping"
    assert module.context.auto_response.response == "pong"
    cli_request = upgrade(token)
    del cli_request.headers["Origin"]
    assert (await module.instance.fetch(cli_request)).status == 101


@pytest.mark.asyncio
async def test_unknown_upgrade_does_not_create_storage_or_accept_sockets(
    runtime: tuple[Any, Storage],
) -> None:
    module, storage = runtime
    assert (await module.instance.fetch(upgrade("x" * 43))).status != 101
    assert not module.context.sockets
    assert storage.writes == 0
    assert storage.alarm_at is None


@pytest.mark.asyncio
async def test_upgrade_limits_connections_per_player_and_lobby(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    room, host_token, guest_token = make_room()
    tokens = [host_token, guest_token]
    for index in range(6):
        player, token = new_player(f"Player {index}", NOW)
        room.join(player)
        tokens.append(token)
    await module.instance.initialize(room.to_json())
    for token in tokens:
        await connect(module, token)
        await connect(module, token)
    assert len(module.context.sockets) == 16
    response = await module.instance.fetch(upgrade(host_token))
    assert response.status != 101
    assert len(module.context.sockets) == 16
    module.context.sockets[-1].close()
    # Still enforce the player's own limit when there is space in the lobby.
    assert (await module.instance.fetch(upgrade(host_token))).status != 101
    assert len(module.context.getWebSockets()) == 15


@pytest.mark.asyncio
async def test_pushes_are_personalized_and_committed_before_delivery(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    room, host_token, guest_token = make_room()
    await module.instance.initialize(room.to_json())
    host = await connect(module, host_token)
    guest = await connect(module, guest_token)

    def verify_committed(message: str) -> None:
        frame = json.loads(message)
        if frame["type"] == "room":
            persisted = module.instance._load()
            assert frame["room"]["revision"] == persisted.revision
            assert frame["room"]["phase"] == persisted.phase

    host.on_send = verify_committed
    guest.on_send = verify_committed
    initial_revision = last_room(host)["revision"]
    start = json.loads(await module.instance.command("start", host_token, "{}"))["result"]
    assert start["revision"] == last_room(host)["revision"] > initial_revision
    assert last_room(guest)["you"] == room.players[1].id
    assert "author" not in last_room(guest)["round"]
    assert "rounds" not in last_room(guest)
    before_read = (len(host.messages), len(guest.messages))
    read = json.loads(await module.instance.command("state", guest_token, "{}"))["result"]
    assert read["revision"] == start["revision"]
    assert (len(host.messages), len(guest.messages)) == before_read
    await module.instance.command("guess", host_token, '{"roundId":"round-0","choice":"chatter_a"}')
    host_view, guest_view = last_room(host), last_room(guest)
    assert host_view["players"][0]["choice"] == "chatter_a"
    assert guest_view["players"][0]["choice"] is None
    assert guest_view["players"][0]["answered"] is True
    assert guest_view["players"][0]["score"] == 0
    assert "author" not in guest_view["round"]
    assert guest_view["revision"] > start["revision"]
    assert host_token not in "".join(guest.messages)
    assert "token_hash" not in "".join(guest.messages)
    await module.instance.command(
        "guess", guest_token, '{"roundId":"round-0","choice":"chatter_b"}'
    )
    assert last_room(host)["phase"] == "reveal"
    assert last_room(guest)["round"]["author"] == "chatter_a"
    assert last_room(guest)["players"][0]["choice"] == "chatter_a"
    assert last_room(guest)["players"][0]["score"] == 1500


@pytest.mark.asyncio
async def test_deadline_alarm_pushes_after_reconstruction_without_polling(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, _storage = runtime
    room, host_token, guest_token = make_room()
    await module.instance.initialize(room.to_json())
    host = await connect(module, host_token)
    guest = await connect(module, guest_token)
    await module.instance.command("start", host_token, "{}")
    await module.instance.command("guess", host_token, '{"roundId":"round-0","choice":"chatter_a"}')
    revision = last_room(host)["revision"]
    restored = module.GameRoom(module.context, module.env)
    monkeypatch.setattr(module, "now_ms", lambda: NOW + 20_000)
    await restored.alarm()
    assert last_room(host)["phase"] == "reveal"
    assert last_room(guest)["round"]["author"] == "chatter_a"
    assert last_room(host)["revision"] > revision
    assert restored._load().players[0].score == 1500
    await restored.alarm()
    assert restored._load().players[0].score == 1500


@pytest.mark.asyncio
async def test_auto_ping_preserves_live_players_across_idle_alarm(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    room, host_token, guest_token = make_room()
    await module.instance.initialize(room.to_json())
    host = await connect(module, host_token)
    guest = await connect(module, guest_token)
    later = NOW + PLAYER_IDLE_MS + 1000
    host.ping_at = later - 25_000
    guest.ping_at = later - 20_000
    restored = module.GameRoom(module.context, module.env)
    monkeypatch.setattr(module, "now_ms", lambda: later)
    await restored.alarm()
    assert len(restored._load().players) == 2
    assert storage.alarm_at is not None and storage.alarm_at > later
    assert not host.closed and not guest.closed


@pytest.mark.asyncio
async def test_leave_and_expiry_notify_and_close_attached_sockets(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    room, host_token, guest_token = make_room()
    await module.instance.initialize(room.to_json())
    host = await connect(module, host_token)
    guest = await connect(module, guest_token)
    await module.instance.command("leave", guest_token, "{}")
    assert guest.closed is not None and guest.closed[0] == 4001
    assert json.loads(guest.messages[-1])["type"] == "error"
    assert json.loads(guest.messages[-1])["status"] == 401
    assert len(last_room(host)["players"]) == 1
    monkeypatch.setattr(module, "now_ms", lambda: NOW + ROOM_LIFETIME_MS)
    await module.instance.alarm()
    assert host.closed is not None and host.closed[0] == 4004
    assert json.loads(host.messages[-1])["status"] == 404
    assert storage.alarm_at is None
    assert module.instance._load() is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message,code", [("unsupported", 1008), (b"binary", 1009), ("x" * 20000, 1009)]
)
async def test_unrecognized_socket_messages_are_bounded_and_closed(
    runtime: tuple[Any, Storage], message: str | bytes, code: int
) -> None:
    module, _storage = runtime
    room, host_token, _guest = make_room()
    await module.instance.initialize(room.to_json())
    socket = await connect(module, host_token)
    await module.instance.webSocketMessage(socket, message)
    assert socket.closed is not None and socket.closed[0] == code


@pytest.mark.asyncio
async def test_native_upgrade_forwards_same_request_and_preserves_other_http_routes(
    runtime: tuple[Any, Storage],
) -> None:
    _module, _storage = runtime
    events = import_module("runtime.room_events")
    seen: list[Any] = []
    native_response = SimpleNamespace(status=101)

    async def fetch(request: Any) -> Any:
        seen.append(request)
        return native_response

    def get_by_name(code: str) -> Any:
        seen.append(code)
        return SimpleNamespace(fetch=fetch)

    env = SimpleNamespace(GAME_ROOMS=SimpleNamespace(getByName=get_by_name))
    request = upgrade("x" * 43)
    request.url = request.url.replace("ABC234", "abc234")
    assert await events.forward_room_events(request, env) is native_response
    assert seen == ["ABC234", request]
    seen.clear()
    request.url = "https://knowthechat.com/api/public-archive"
    request.method = "POST"
    assert await events.forward_room_events(request, env) is None
    assert seen == []


@pytest.mark.asyncio
async def test_upgrade_router_rejects_invalid_code_and_origin_before_binding_access(
    runtime: tuple[Any, Storage],
) -> None:
    _module, _storage = runtime
    events = import_module("runtime.room_events")
    seen: list[str] = []

    def get_by_name(code: str) -> None:
        seen.append(code)
        raise AssertionError("Invalid requests must not address a Durable Object")

    env = SimpleNamespace(GAME_ROOMS=SimpleNamespace(getByName=get_by_name))
    bad_code = upgrade("x" * 43)
    bad_code.url = bad_code.url.replace("ABC234", "invalid-code")
    assert (await events.forward_room_events(bad_code, env)).status == 400
    bad_origin = upgrade("x" * 43, Origin="https://unrelated.example")
    assert (await events.forward_room_events(bad_origin, env)).status == 403
    bad_method = upgrade("x" * 43)
    bad_method.method = "POST"
    assert (await events.forward_room_events(bad_method, env)).status == 426
    assert seen == []
