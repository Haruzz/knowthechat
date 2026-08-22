from __future__ import annotations

import asgi
from workers import Request, WorkerEntrypoint

from fastapi_app import BoundedRequestBodyMiddleware, create_app
from providers.archives import RecentMessagesProvider, ZonianHistoricalProvider
from providers.emotes import BetterTtvProvider, FrankerFaceZProvider, SevenTvProvider
from runtime.http import CloudflareJsonHttpClient
from services.public_archive import PublicArchiveService, StructuredLogger

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
    async def fetch(self, request: Request):
        return await asgi.fetch(  # pyright: ignore[reportAttributeAccessIssue]
            APP, request, self.env
        )
