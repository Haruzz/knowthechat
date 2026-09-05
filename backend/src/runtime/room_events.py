"""Validate and forward the native WebSocket upgrade outside the ASGI adapter."""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from workers import Request, Response

from domain.rooms import RoomError
from runtime.bindings import RoomEnvironment
from services.rooms import normalize_code

PROTOCOL = "knowthechat.v1"
TOKEN_PROTOCOL = re.compile(r"session\.([A-Za-z0-9_-]{43})")
EVENT_PATH = re.compile(r"/api/rooms/([^/]+)/events")


def socket_token(request: Request) -> str:
    if request.method != "GET" or (request.headers.get("upgrade") or "").lower() != "websocket":
        raise RoomError("Use a WebSocket connection for live lobby updates.", 426)
    origin = request.headers.get("origin")
    target = urlsplit(request.url)
    if origin and origin != f"{target.scheme}://{target.netloc}":
        raise RoomError("Use this site's lobby page to play.", 403)
    offered = request.headers.get("sec-websocket-protocol") or ""
    if len(offered) > 128:
        raise RoomError("Invalid lobby connection.", 401)
    protocols = [part.strip() for part in offered.split(",")]
    matches = [TOKEN_PROTOCOL.fullmatch(part) for part in protocols]
    tokens = [match.group(1) for match in matches if match]
    if len(protocols) != 2 or PROTOCOL not in protocols or len(tokens) != 1:
        raise RoomError("Join this lobby to continue.", 401)
    return tokens[0]


def socket_error(error: RoomError) -> Response:
    return Response.from_json(
        {"error": str(error)}, status=error.status, headers={"Cache-Control": "no-store"}
    )


async def forward_room_events(request: Request, env: RoomEnvironment) -> Response | None:
    match = EVENT_PATH.fullmatch(urlsplit(request.url).path)
    if not match:
        return None
    try:
        code = normalize_code(match.group(1))
        socket_token(request)
        # ASGI's ordinary WebSocket accept/listeners do not support DO hibernation.
        return await env.GAME_ROOMS.getByName(code).fetch(request)
    except RoomError as error:
        return socket_error(error)
    except Exception:
        return socket_error(RoomError("Live updates are temporarily unavailable.", 503))
