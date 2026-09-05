from __future__ import annotations

from typing import TYPE_CHECKING, cast

from workers import Request, Response, WorkerEntrypoint, asgi

from fastapi_app import BoundedRequestBodyMiddleware, create_app
from providers.archives import RecentMessagesProvider, ZonianHistoricalProvider
from providers.emotes import BetterTtvProvider, FrankerFaceZProvider, SevenTvProvider
from runtime.bindings import RoomEnvironment
from runtime.http import CloudflareJsonHttpClient
from runtime.room_events import forward_room_events
from runtime.rooms import GameRoom as GameRoom
from services.public_archive import PublicArchiveService, StructuredLogger

if TYPE_CHECKING:
    from js import Response as JsResponse  # pyright: ignore[reportMissingModuleSource]

RECENT_PROVIDER_URLS = (
    "https://recent-messages.robotty.de/api/v2/recent-messages/",
    "https://recent-messages.zneix.eu/api/v2/recent-messages/",
    "https://logs.zonian.dev/rm/",
)


def _build_service() -> PublicArchiveService:
    client = CloudflareJsonHttpClient()
    return PublicArchiveService(
        ZonianHistoricalProvider(client),
        [RecentMessagesProvider(client, url) for url in RECENT_PROVIDER_URLS],
        [SevenTvProvider(client), BetterTtvProvider(client), FrankerFaceZProvider(client)],
        logger=StructuredLogger(),
    )


APP = BoundedRequestBodyMiddleware(create_app(_build_service()))


class Default(WorkerEntrypoint):
    async def fetch(self, request: Request) -> Response | JsResponse:
        # Workers wraps env bindings in Python RPC adapters before this handler.
        env = cast(RoomEnvironment, self.env)
        events = await forward_room_events(request, env)
        if events is not None:
            return events
        return await asgi.fetch(APP, request, env)
