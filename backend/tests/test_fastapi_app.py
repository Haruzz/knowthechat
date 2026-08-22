from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
from httpx import ASGITransport, AsyncClient

from api_models import PublicArchiveRequest, PublicArchiveResponse
from fastapi_app import MAX_REQUEST_BYTES, BoundedRequestBodyMiddleware, create_app
from services.public_archive import NoPublicArchiveError


class CapturingService:
    def __init__(self, error: Exception | None = None) -> None:
        self.request: PublicArchiveRequest | None = None
        self.error = error

    async def execute(self, request: PublicArchiveRequest) -> PublicArchiveResponse:
        self.request = request
        if self.error:
            raise self.error
        return PublicArchiveResponse(
            channel=request.channel,
            roomId="",
            chatters=[],
            quotes=[],
            total=0,
            range=None,
        )


def client_for(service: CapturingService) -> AsyncClient:
    app = BoundedRequestBodyMiddleware(create_app(service))
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver")


@pytest.mark.asyncio
async def test_valid_request_preserves_response_contract() -> None:
    service = CapturingService()
    async with client_for(service) as client:
        response = await client.post(
            "/api/public-archive",
            json={"channel": "@Haruzz", "rangeDays": "30", "chatterPool": 25},
        )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "channel": "haruzz",
        "roomId": "",
        "chatters": [],
        "quotes": [],
        "total": 0,
        "range": None,
    }
    assert service.request is not None
    assert service.request.range_days == 30
    assert service.request.archive_year is None


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["", "ab", "invalid-name", None, "a" * 26])
async def test_invalid_channel_matches_existing_error(channel: object) -> None:
    async with client_for(CapturingService()) as client:
        response = await client.post("/api/public-archive", json={"channel": channel})
    assert response.status_code == 400
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"error": "Enter a valid Twitch channel name."}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("value", "expected"),
    [(0, 90), (-5, 1), (99999, 90), ("bad", 90), (30.5, 30.5)],
)
async def test_lookback_coercion(value: object, expected: float | None) -> None:
    service = CapturingService()
    async with client_for(service) as client:
        await client.post("/api/public-archive", json={"channel": "haruzz", "rangeDays": value})
    assert service.request is not None
    assert service.request.range_days == expected
    assert service.request.archive_year is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("value", "expected"),
    [(2024, 2024), (1900, 2011), (9999, datetime.now(UTC).year), ("bad", datetime.now(UTC).year)],
)
async def test_archive_year_coercion(value: object, expected: int) -> None:
    service = CapturingService()
    async with client_for(service) as client:
        await client.post("/api/public-archive", json={"channel": "haruzz", "archiveYear": value})
    assert service.request is not None
    assert service.request.archive_year == expected
    assert service.request.range_days is None


@pytest.mark.asyncio
async def test_missing_period_defaults_to_current_year() -> None:
    service = CapturingService()
    async with client_for(service) as client:
        await client.post("/api/public-archive", json={"channel": "haruzz"})
    assert service.request is not None
    assert service.request.range_days is None
    assert service.request.archive_year == datetime.now(UTC).year


@pytest.mark.asyncio
async def test_no_archive_error_is_404() -> None:
    service = CapturingService(
        NoPublicArchiveError("No public archive was found for that channel.")
    )
    async with client_for(service) as client:
        response = await client.post("/api/public-archive", json={"channel": "haruzz"})
    assert response.status_code == 404
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"error": "No public archive was found for that channel."}


@pytest.mark.asyncio
async def test_method_and_unknown_api_errors_preserve_contract() -> None:
    async with client_for(CapturingService()) as client:
        method_response = await client.get("/api/public-archive")
        missing_response = await client.get("/api/unknown")
    assert method_response.status_code == 405
    assert method_response.headers["allow"] == "POST"
    assert method_response.json() == {"error": "Method not allowed."}
    assert missing_response.status_code == 404
    assert missing_response.json() == {"error": "Not found."}


@pytest.mark.asyncio
async def test_malformed_and_streamed_oversized_bodies_are_rejected() -> None:
    async def oversized_body() -> AsyncIterator[bytes]:
        yield b"x" * (MAX_REQUEST_BYTES // 2)
        yield b"x" * (MAX_REQUEST_BYTES // 2 + 1)

    async with client_for(CapturingService()) as client:
        malformed_response = await client.post(
            "/api/public-archive", content=b"{", headers={"Content-Type": "application/json"}
        )
        oversized_response = await client.post(
            "/api/public-archive",
            content=oversized_body(),
            headers={"Content-Type": "application/json"},
        )
    assert malformed_response.status_code == 400
    assert malformed_response.json() == {"error": "Enter a valid Twitch channel name."}
    assert oversized_response.status_code == 413
    assert oversized_response.json() == {"error": "Request body is too large."}
