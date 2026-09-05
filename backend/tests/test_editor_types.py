"""Pyright checks these editor contracts as part of `npm run check`.

They are never executed: native Cloudflare objects exist only in the Worker.
Unlike runtime assertions, assert_type fails when a known value regresses to Any.
"""

from typing import TYPE_CHECKING, assert_type

if TYPE_CHECKING:
    from js import (  # pyright: ignore[reportMissingModuleSource]
        ReadableStream,
        Uint8Array,
        WebSocket,
    )
    from workers import Request, Response

    from domain.rooms import Room
    from room_types import LeaveResult, Phase, RoomSession, RoomSnapshot
    from runtime.bindings import RoomNamespace, RoomStorage, SqlValue
    from runtime.http import CloudflareJsonHttpClient, response_body
    from runtime.rooms import socket_player_id
    from services.room_commands import execute_command

    async def editor_contracts(
        request: Request,
        response: Response,
        socket: WebSocket,
        namespace: RoomNamespace,
        storage: RoomStorage,
        room: Room,
        client: CloudflareJsonHttpClient,
    ) -> None:
        assert_type(request.headers.get("origin"), str | None)
        assert_type(socket_player_id(socket), str | None)
        assert_type(socket.send("hello"), None)
        assert_type(await namespace.getByName("ABC234").command("state", "token", "{}"), str)
        rows = storage.sql.exec("SELECT body FROM room_state").toArray()
        assert_type(rows[0]["body"], SqlValue)

        snapshot = execute_command(room, "state", "token", {}, 0)
        assert_type(snapshot, RoomSnapshot)
        assert_type(snapshot["phase"], Phase)
        assert_type(snapshot["players"][0]["score"], int)
        assert_type(snapshot["players"][0]["choice"], str | None)
        if snapshot["round"] is not None:
            assert_type(snapshot["round"].get("author"), str | None)
        assert_type(execute_command(room, "join", "", {"name": "Guest"}, 0), RoomSession)
        assert_type(execute_command(room, "leave", "token", {}, 0), LeaveResult)

        body = response_body(response)
        assert_type(body, ReadableStream[Uint8Array] | None)
        if body is not None:
            result = await body.getReader().read()
            if result.done is False:
                assert_type(result.value, Uint8Array)
        assert_type(
            await client.get_json(
                "https://example.com", timeout_ms=1000, max_bytes=1024, user_agent="test"
            ),
            object,
        )
