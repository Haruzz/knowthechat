from __future__ import annotations

from typing import TYPE_CHECKING, cast

from workers import Request, Response, WorkerEntrypoint, asgi

from fastapi_app import BoundedRequestBodyMiddleware, create_app
from runtime.admission import RoomAdmission as RoomAdmission
from runtime.archive import build_archive_service
from runtime.bindings import RoomEnvironment
from runtime.room_events import forward_room_events
from runtime.rooms import GameRoom as GameRoom

if TYPE_CHECKING:
    from js import Response as JsResponse  # pyright: ignore[reportMissingModuleSource]


APP = BoundedRequestBodyMiddleware(create_app(build_archive_service()))


class Default(WorkerEntrypoint):
    async def fetch(self, request: Request) -> Response | JsResponse:
        # Workers wraps env bindings in Python RPC adapters before this handler.
        env = cast(RoomEnvironment, self.env)
        events = await forward_room_events(request, env)
        if events is not None:
            return events
        return await asgi.fetch(APP, request, env)
