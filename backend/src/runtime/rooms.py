"""Coordinate lobby storage and native sockets through typed Cloudflare boundaries."""

from __future__ import annotations

import asyncio
import json
import secrets
from typing import TYPE_CHECKING, cast

# Cloudflare provides `js` at runtime; backend/typings supplies local editor types.
# Both globals are used in Cloudflare's Python hibernation example:
# https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
from js import (  # pyright: ignore[reportMissingModuleSource]
    WebSocketPair,
    WebSocketRequestResponsePair,
)
from pydantic import ValidationError
from workers import DurableObject, Request, Response

from domain.rooms import PLAYER_IDLE_MS, Room, RoomError
from room_models import EmptyRoomRequest
from room_types import CommandPayload, CommandResult, RoomResult, snapshot_from_result
from runtime.admission import CloudflareAdmissionGateway
from runtime.bindings import RoomEnvironment, RoomNamespace, RoomStorage
from runtime.room_events import PROTOCOL, socket_error, socket_token
from services.room_commands import execute_command
from services.rooms import (
    MAX_ROOM_STATE_BYTES,
    ArchiveService,
    decode_result,
    fresh_rounds,
    now_ms,
    result_json,
)

if TYPE_CHECKING:
    from js import (  # pyright: ignore[reportMissingModuleSource]
        ArrayBuffer,
        DurableObjectState,
        Env,
        WebSocket,
    )


def socket_player_id(socket: WebSocket) -> str | None:
    attachment: object = socket.deserializeAttachment()
    return attachment if isinstance(attachment, str) else None


class CloudflareRoomGateway:
    def __init__(self, namespace: RoomNamespace) -> None:
        self.namespace = namespace

    async def initialize(self, code: str, state: str) -> None:
        try:
            result = await self.namespace.getByName(code).initialize(state)
        except Exception as error:
            raise RoomError(
                "Lobbies are temporarily unavailable. Please try again.", 503
            ) from error
        decode_result(result)

    async def command(
        self, code: str, action: str, token: str, payload: CommandPayload
    ) -> RoomResult:
        try:
            result = await self.namespace.getByName(code).command(
                action, token, json.dumps(payload)
            )
        except Exception as error:
            raise RoomError(
                "Lobbies are temporarily unavailable. Please try again.", 503
            ) from error
        return decode_result(result)


class GameRoom(DurableObject):
    """One SQLite-backed object per lobby. No background loops or in-memory authority."""

    def __init__(self, ctx: DurableObjectState[object], env: Env) -> None:
        super().__init__(ctx, env)
        # The SDK dynamically wraps JS storage methods; isolate that boundary here.
        self.storage = cast(RoomStorage, self.ctx.storage)
        self.socket_state = cast("DurableObjectState[object]", self.ctx)

        # Static heartbeats are answered by the runtime without waking Python.
        # The generator types new() as the instance interface, while this setter
        # expects the proxy class. Both describe the same runtime object.
        auto_response = cast(
            WebSocketRequestResponsePair, WebSocketRequestResponsePair.new("ping", "pong")
        )
        self.socket_state.setWebSocketAutoResponse(auto_response)

    def _admission(self) -> CloudflareAdmissionGateway:
        try:
            namespace = cast(RoomEnvironment, self.env).ROOM_ADMISSION
        except AttributeError as error:
            raise RoomError(
                "Lobbies are temporarily unavailable. Please try again.", 503, 15
            ) from error
        return CloudflareAdmissionGateway(namespace)

    def _archive(self) -> ArchiveService:
        from runtime.archive import build_archive_service

        return build_archive_service()

    async def _rematch(self, room: Room, token: str, now: int) -> str:
        attempt = ""
        try:
            previous = room.to_json()
            self._refresh_presence(room, now)
            room.advance(now)
            ticket = self._match_ticket(room, "rematch", token)
            if room.archive_settings is None:
                raise RoomError("Create a new lobby to fetch fresh chat for rematches.", 409)
            if room.rematch_attempt and now < room.rematch_until:
                raise RoomError("Fresh chat is already being prepared. Please wait.", 409)
            attempt = secrets.token_urlsafe(24)
            room.rematch_attempt = attempt
            room.rematch_until = min(room.expires_at, now + 120_000)
            room.authenticate(token).last_seen = now
            # Persist the attempt before any I/O. Concurrent requests cannot fetch
            # another deck; the lease also recovers a crashed preparation.
            self._persist(room, previous, now)
            async with asyncio.timeout(90):
                await self._schedule(room)
                await self._admission().admit_rematch(ticket[0], attempt, ticket[1])
                rounds = await fresh_rounds(room, self._archive())
            # Leaves, host transfers and expiry can happen during archive I/O.
            now = now_ms()
            current = self._load()
            if current is None:
                raise RoomError("Lobby not found or expired.", 404)
            if now >= current.expires_at:
                await self._delete(current)
                raise RoomError("Lobby not found or expired.", 404)
            previous = current.to_json()
            self._refresh_presence(current, now)
            current.advance(now)
            if (
                current.rematch_attempt != attempt
                or now >= current.rematch_until
                or self._match_ticket(current, "rematch", token) != ticket
            ):
                raise RoomError("The lobby changed. Please try again.", 409)
            player = current.authenticate(token)
            current.rematch(player, rounds)
            if len(current.to_json().encode()) > MAX_ROOM_STATE_BYTES:
                raise RoomError("Fresh chat is too large for this lobby. Please try again.", 422)
            self._persist(current, previous, now)
            await self._schedule(current)
            return result_json(current.snapshot(player, now))
        except RoomError as error:
            return result_json(error=error)
        except TimeoutError:
            return result_json(
                error=RoomError("Fresh chat took too long. Please try again shortly.", 503, 15)
            )
        except Exception:
            return result_json(
                error=RoomError(
                    "Fresh chat could not be loaded. Please try again shortly.", 503, 15
                )
            )
        finally:
            if attempt:
                current = self._load()
                if current is not None and current.rematch_attempt == attempt:
                    previous = current.to_json()
                    current.rematch_attempt = ""
                    current.rematch_until = 0
                    self._persist(current, previous, now_ms())

    @staticmethod
    def _match_ticket(room: Room, action: str, token: str) -> tuple[str, int]:
        player = room.authenticate(token)
        room.require_host(player)
        if action == "start":
            if room.phase != "waiting":
                raise RoomError("The match has already started.", 409)
            room._require_players()
        elif room.phase != "finished":
            raise RoomError("Finish this match before a rematch.", 409)
        if not room.admission_id:
            # Rooms from the previous deployment may finish their running game.
            raise RoomError("Create a new lobby to start another game.", 409)
        return room.admission_id, room.match_number + int(action == "rematch")

    def _refresh_presence(self, room: Room, now: int) -> None:
        members = {player.id: player for player in room.players}
        for socket in self.socket_state.getWebSockets():
            player = members.get(socket_player_id(socket) or "")
            if player is None:
                continue
            timestamp = self.socket_state.getWebSocketAutoResponseTimestamp(socket)
            if timestamp:
                player.last_seen = max(player.last_seen, min(now, int(timestamp.getTime())))

    @staticmethod
    def _close(socket: WebSocket, status: int, message: str) -> None:
        try:
            socket.send(json.dumps({"type": "error", "error": message, "status": status}))
            socket.close(4001 if status == 401 else 4004, message)
        except Exception:
            # A disconnected client cannot prevent a room commit or broadcast.
            pass

    def _broadcast(self, room: Room, now: int) -> None:
        members = {player.id: player for player in room.players}
        for socket in self.socket_state.getWebSockets():
            player = members.get(socket_player_id(socket) or "")
            if player is None:
                self._close(socket, 401, "Your lobby session has ended.")
                continue
            try:
                socket.send(json.dumps({"type": "room", "room": room.snapshot(player, now)}))
            except Exception:
                try:
                    socket.close(1011, "Reconnect to the lobby.")
                except Exception:
                    pass

    def _persist(self, room: Room, previous: str, now: int) -> bool:
        if room.to_json() == previous:
            return False
        room.revision += 1
        self._save(room.to_json())
        # Send before any await, so a later command cannot be followed by an older push.
        # SQLite output gates hold these messages until the write is committed.
        self._broadcast(room, now)
        return True

    async def fetch(self, request: Request) -> Response:
        try:
            token = socket_token(request)
            now = now_ms()
            room = self._load()
            if room is None:
                raise RoomError("Lobby not found or expired.", 404)
            if now >= room.expires_at:
                await self._delete(room)
                raise RoomError("Lobby not found or expired.", 404)
            # Authenticate before accepting sockets or writing presence.
            player = room.authenticate(token)
            previous = room.to_json()
            self._refresh_presence(room, now)
            room.advance(now)
            if player not in room.players:
                changed = self._persist(room, previous, now)
                if not room.players:
                    await self._delete(room)
                elif changed:
                    await self._schedule(room)
                raise RoomError("Your lobby session has expired. Join the lobby again.", 401)
            sockets = list(self.socket_state.getWebSockets())
            if (
                len(sockets) >= 16
                or sum(socket_player_id(socket) == player.id for socket in sockets) >= 2
            ):
                raise RoomError("Too many connections. Close another lobby tab and retry.", 429)
            player.last_seen = now
            self._persist(room, previous, now)
            # This pair creates the connection; the other pair configures heartbeat replies.
            client, server = cast(
                "tuple[WebSocket, WebSocket]", WebSocketPair.new().object_values()
            )
            self.socket_state.acceptWebSocket(server)
            server.serializeAttachment(player.id)
            server.send(json.dumps({"type": "room", "room": room.snapshot(player, now)}))
            await self._schedule(room)
            return Response(
                status=101,
                web_socket=client,
                headers={"Sec-WebSocket-Protocol": PROTOCOL, "Cache-Control": "no-store"},
            )
        except RoomError as error:
            return socket_error(error)

    async def webSocketMessage(self, socket: WebSocket, message: str | ArrayBuffer) -> None:
        # Gameplay commands stay on the validated HTTP boundary. Only runtime
        # auto-response heartbeats are expected on this push connection.
        if not isinstance(message, str) or len(message) > 128:
            socket.close(1009, "Unexpected lobby message.")
        else:
            socket.close(1008, "Use the lobby controls to play.")

    async def webSocketClose(
        self, socket: WebSocket, code: int, reason: str, was_clean: bool
    ) -> None:
        # Since compatibility date 2026-04-07, the runtime replies to close frames.
        # Persisted presence retains the existing reconnect grace period.
        pass

    async def webSocketError(self, socket: WebSocket, error: object) -> None:
        try:
            socket.close(1011, "Reconnect to the lobby.")
        except Exception:
            pass

    def _load(self) -> Room | None:
        # Reads to made-up codes must not create permanent schema or alarms.
        tables = self.storage.sql.exec(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_state'"
        ).toArray()
        if not tables:
            return None
        rows = self.storage.sql.exec("SELECT body FROM room_state WHERE id = 1").toArray()
        if not rows:
            return None
        body = rows[0]["body"]
        if not isinstance(body, str):
            raise ValueError("Stored lobby state must be JSON text.")
        return Room.from_json(body)

    def _save(self, state: str) -> None:
        self.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY, body TEXT NOT NULL)"
        )
        self.storage.sql.exec(
            "INSERT INTO room_state (id, body) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET body = excluded.body",
            state,
        )

    async def _schedule(self, room: Room) -> None:
        alarm_at = min(
            room.expires_at,
            room.deadline or room.expires_at,
            *(player.last_seen + PLAYER_IDLE_MS for player in room.players),
        )
        await self.storage.setAlarm(alarm_at)

    async def _delete(self, room: Room | None = None) -> None:
        # Our 2026-08-22 compatibility date makes this clear data AND alarms atomically.
        sockets = list(self.socket_state.getWebSockets())
        await self.storage.deleteAll()
        for socket in sockets:
            self._close(socket, 404, "Lobby not found or expired.")
        if room is not None and room.admission_id:
            try:
                await self._admission().release(room.admission_id)
            except Exception:
                # A missed release cannot strand a slot past the room's fixed expiry.
                pass

    async def initialize(self, state: str) -> str:
        if len(state.encode()) > MAX_ROOM_STATE_BYTES:
            return result_json(error=RoomError("The lobby is too large.", 422))
        room = Room.from_json(state)
        existing = self._load()
        if existing is not None:
            if room.admission_id and existing.admission_id == room.admission_id:
                return result_json()
            return result_json(error=RoomError("Lobby code already exists.", 409))
        if not room.admission_id:
            return result_json(error=RoomError("A lobby reservation is required.", 503))
        try:
            await self._admission().activate(room.admission_id, room.expires_at)
        except RoomError as error:
            return result_json(error=error)
        # Another initialize may have arrived while the admission RPC was pending.
        existing = self._load()
        if existing is not None:
            if existing.admission_id == room.admission_id:
                return result_json()
            return result_json(error=RoomError("Lobby code already exists.", 409))
        if now_ms() >= room.expires_at:
            return result_json(error=RoomError("The lobby reservation expired.", 409))
        room.revision += 1
        self._save(room.to_json())
        await self._schedule(room)
        return result_json()

    async def command(self, action: str, token: str, payload_json: str) -> str:
        if len(payload_json) > 16_384 or len(token) > 128:
            return result_json(error=RoomError("Invalid lobby request."))
        now = now_ms()
        room = self._load()
        if room is None:
            return result_json(error=RoomError("Lobby not found or expired.", 404))
        if now >= room.expires_at:
            await self._delete(room)
            return result_json(error=RoomError("Lobby not found or expired.", 404))
        if action == "rematch":
            try:
                EmptyRoomRequest.model_validate_json(payload_json)
            except (ValidationError, ValueError, TypeError):
                return result_json(error=RoomError("Invalid lobby request."))
            return await self._rematch(room, token, now)
        ticket: tuple[str, int] | None = None
        if action == "start":
            try:
                EmptyRoomRequest.model_validate_json(payload_json)
                self._refresh_presence(room, now)
                room.advance(now)
                ticket = self._match_ticket(room, action, token)
                await self._admission().admit_match(*ticket)
            except RoomError as error:
                return result_json(error=error)
            except (ValidationError, ValueError, TypeError):
                return result_json(error=RoomError("Invalid lobby request."))
            # Game state remains authoritative in this room. Reload after the RPC
            # so a concurrent join, leave, alarm or command cannot be overwritten.
            now = now_ms()
            room = self._load()
            if room is None:
                return result_json(error=RoomError("Lobby not found or expired.", 404))
            if now >= room.expires_at:
                await self._delete(room)
                return result_json(error=RoomError("Lobby not found or expired.", 404))
        previous = room.to_json()
        self._refresh_presence(room, now)
        payload: CommandResult | None = None
        failure: RoomError | None = None
        try:
            if ticket is not None:
                room.advance(now)
                if self._match_ticket(room, action, token) != ticket:
                    raise RoomError("The lobby changed. Please try again.", 409)
            payload = execute_command(room, action, token, json.loads(payload_json), now)
        except RoomError as error:
            failure = error
        except (ValidationError, ValueError, TypeError):
            failure = RoomError("Invalid lobby request.")
        if not room.players:
            await self._delete(room)
            return (
                result_json(payload, error=failure)
                if action == "leave"
                else result_json(error=RoomError("Lobby not found or expired.", 404))
            )
        changed = self._persist(room, previous, now)
        if payload is not None:
            # execute_command created its snapshot before the persistence revision.
            snapshot = snapshot_from_result(payload)
            if snapshot is not None:
                snapshot["revision"] = room.revision
        if changed:
            await self._schedule(room)
        return result_json(payload, error=failure)

    async def alarm(self, _alarm_info: object = None) -> None:
        now = now_ms()
        room = self._load()
        if room is None or now >= room.expires_at:
            await self._delete(room)
            return
        previous = room.to_json()
        self._refresh_presence(room, now)
        room.advance(now)
        if not room.players:
            await self._delete(room)
            return
        self._persist(room, previous, now)
        await self._schedule(room)
