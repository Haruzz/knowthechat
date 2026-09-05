"""Compose public archive providers for Worker requests and fresh rematches."""

from providers.archives import RecentMessagesProvider, ZonianHistoricalProvider
from providers.emotes import BetterTtvProvider, FrankerFaceZProvider, SevenTvProvider
from runtime.http import CloudflareJsonHttpClient
from services.public_archive import PublicArchiveService, StructuredLogger

RECENT_PROVIDER_URLS = (
    "https://recent-messages.robotty.de/api/v2/recent-messages/",
    "https://recent-messages.zneix.eu/api/v2/recent-messages/",
    "https://logs.zonian.dev/rm/",
)


def build_archive_service() -> PublicArchiveService:
    client = CloudflareJsonHttpClient()
    return PublicArchiveService(
        ZonianHistoricalProvider(client),
        [RecentMessagesProvider(client, url) for url in RECENT_PROVIDER_URLS],
        [SevenTvProvider(client), BetterTtvProvider(client), FrankerFaceZProvider(client)],
        logger=StructuredLogger(),
    )
