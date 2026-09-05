from __future__ import annotations

import re
from typing import TYPE_CHECKING, cast
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from domain.rooms import RoomError
from room_models import CreateRoomRequest, EmptyRoomRequest, GuessRequest, JoinRoomRequest
from room_types import RoomResult
from services.rooms import ArchiveService, RoomGateway, RoomService, normalize_code

if TYPE_CHECKING:
    from runtime.bindings import RoomEnvironment

NO_STORE = {"Cache-Control": "no-store"}
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")


def bearer(request: Request) -> str:
    value = request.headers.get("authorization", "")
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer" or not TOKEN_PATTERN.fullmatch(token):
        raise RoomError("Join this lobby to continue.", 401)
    return token


def check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and urlparse(origin).netloc != request.headers.get("host"):
        raise RoomError("Use this site's lobby page to play.", 403)


def add_room_routes(
    app: FastAPI, archive: ArchiveService, gateway: RoomGateway | None = None
) -> None:
    def gateway_for(request: Request) -> RoomGateway:
        check_origin(request)
        if gateway is not None:
            return gateway
        # ASGI's supported env scope contains the per-request Cloudflare bindings.
        env = request.scope.get("env")
        if env is None:
            raise RoomError("Lobbies are unavailable in this environment.", 503)
        from runtime.rooms import CloudflareRoomGateway

        return CloudflareRoomGateway(cast("RoomEnvironment", env).GAME_ROOMS)

    def response(payload: RoomResult) -> JSONResponse:
        return JSONResponse(payload, headers=NO_STORE)

    @app.exception_handler(RoomError)
    async def room_error(_request: Request, error: RoomError) -> JSONResponse:
        return JSONResponse({"error": str(error)}, status_code=error.status, headers=NO_STORE)

    @app.post("/api/rooms")
    async def create_room(payload: CreateRoomRequest, request: Request) -> JSONResponse:
        service = RoomService(archive, gateway_for(request))
        return response(await service.create(payload))

    @app.post("/api/rooms/{code}/join")
    async def join_room(code: str, payload: JoinRoomRequest, request: Request) -> JSONResponse:
        code = normalize_code(code)
        return response(
            await gateway_for(request).command(code, "join", "", {"name": payload.name})
        )

    @app.get("/api/rooms/{code}")
    async def room_state(code: str, request: Request) -> JSONResponse:
        code = normalize_code(code)
        token = bearer(request)
        return response(await gateway_for(request).command(code, "state", token, {}))

    @app.post("/api/rooms/{code}/guess")
    async def guess_room(code: str, payload: GuessRequest, request: Request) -> JSONResponse:
        code = normalize_code(code)
        token = bearer(request)
        return response(
            await gateway_for(request).command(
                code, "guess", token, {"roundId": payload.round_id, "choice": payload.choice}
            )
        )

    @app.post("/api/rooms/{code}/{action}")
    async def room_action(
        code: str, action: str, payload: EmptyRoomRequest, request: Request
    ) -> JSONResponse:
        if action not in ("start", "next", "rematch", "leave"):
            raise RoomError("Not found.", 404)
        code = normalize_code(code)
        token = bearer(request)
        return response(await gateway_for(request).command(code, action, token, {}))
