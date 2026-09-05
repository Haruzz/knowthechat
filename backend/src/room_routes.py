from __future__ import annotations

import hashlib
import re
from ipaddress import ip_address
from typing import TYPE_CHECKING, cast
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from domain.admission import AdmissionGateway
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
    app: FastAPI,
    archive: ArchiveService,
    gateway: RoomGateway | None = None,
    admission: AdmissionGateway | None = None,
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

    def admission_for(request: Request) -> AdmissionGateway:
        if admission is not None:
            return admission
        env = request.scope.get("env")
        if env is None:
            raise RoomError(
                "Lobbies are temporarily unavailable. Please try again shortly.", 503, 15
            )
        try:
            namespace = cast("RoomEnvironment", env).ROOM_ADMISSION
        except AttributeError as error:
            raise RoomError(
                "Lobbies are temporarily unavailable. Please try again shortly.", 503, 15
            ) from error
        from runtime.admission import CloudflareAdmissionGateway

        return CloudflareAdmissionGateway(namespace)

    def response(payload: RoomResult) -> JSONResponse:
        return JSONResponse(payload, headers=NO_STORE)

    @app.exception_handler(RoomError)
    async def room_error(_request: Request, error: RoomError) -> JSONResponse:
        body: dict[str, str | int] = {"error": str(error)}
        headers = dict(NO_STORE)
        if error.retry_after is not None:
            body["retryAfter"] = error.retry_after
            headers["Retry-After"] = str(error.retry_after)
        return JSONResponse(body, status_code=error.status, headers=headers)

    @app.post("/api/rooms")
    async def create_room(payload: CreateRoomRequest, request: Request) -> JSONResponse:
        room_gateway = gateway_for(request)
        # Cloudflare supplies this header on production traffic; local ASGI falls
        # back to its direct peer. Never accept caller-controlled X-Forwarded-For.
        addresses = request.headers.getlist("cf-connecting-ip")
        if len(addresses) > 1:
            raise RoomError("Could not verify this connection. Please try again.", 503, 15)
        address = addresses[0] if addresses else None
        if address is None and request.client is not None:
            address = request.client.host
        # Local Wrangler can omit both the header and the ASGI client address.
        # Such requests share one fixed bucket; no admission limit is bypassed.
        normalized = "unknown-client"
        if address is not None:
            try:
                normalized = str(ip_address(address))
            except ValueError:
                raise RoomError(
                    "Could not verify this connection. Please try again.", 503, 15
                ) from None
        creator_key = hashlib.sha256(normalized.encode()).hexdigest()
        service = RoomService(archive, room_gateway, admission=admission_for(request))
        return response(await service.create(payload, creator_key))

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
