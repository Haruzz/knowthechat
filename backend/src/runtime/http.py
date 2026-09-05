from __future__ import annotations

import json
from typing import TYPE_CHECKING, cast

# Cloudflare provides `js` at runtime; backend/typings supplies local editor types.
from js import AbortSignal  # pyright: ignore[reportMissingModuleSource]
from workers import Response, fetch

from providers.protocols import HttpResponseTooLargeError

if TYPE_CHECKING:
    from js import ReadableStream, Uint8Array  # pyright: ignore[reportMissingModuleSource]
    from workers.types import FetchKwargs

    class HttpFetchOptions(FetchKwargs, total=False):
        # The SDK forwards this Fetch API option but omits it from FetchKwargs.
        signal: AbortSignal


def response_body(source: Response) -> ReadableStream[Uint8Array] | None:
    # HTTP bodies yield byte chunks; the SDK's property omits both the element
    # type and the possibility of a null body (for example, a 204 response).
    return cast("ReadableStream[Uint8Array] | None", source.body)


async def cancel_body(source: Response, reason: str) -> None:
    stream = response_body(source)
    if stream is None:
        return
    try:
        await stream.cancel(reason)
    except Exception:
        pass


async def read_bounded_body(source: Response, maximum: int) -> bytearray | None:
    stream = response_body(source)
    if stream is None:
        return bytearray()
    reader = stream.getReader()
    body = bytearray()
    while True:
        result = await reader.read()
        if result.done is True:
            return body
        chunk = bytes(result.value.to_py())
        if len(body) + len(chunk) > maximum:
            await reader.cancel("body exceeded configured limit")
            return None
        body.extend(chunk)


class CloudflareJsonHttpClient:
    async def get_json(
        self,
        url: str,
        *,
        timeout_ms: int,
        max_bytes: int,
        user_agent: str,
        cache_ttl: int | None = None,
        accepted_statuses: tuple[int, ...] = (),
    ) -> object:
        options: HttpFetchOptions = {
            "headers": {"Accept": "application/json", "User-Agent": user_agent},
            "signal": AbortSignal.timeout(timeout_ms),
        }
        if cache_ttl is not None:
            options["cf"] = {"cacheEverything": True, "cacheTtl": cache_ttl}
        try:
            response = await fetch(url, **options)
        except Exception:
            return None
        if not response.ok and response.status not in accepted_statuses:
            await cancel_body(response, "upstream response was not successful")
            return None
        raw_content_length = response.headers.get("content-length")
        if raw_content_length:
            try:
                if int(raw_content_length) > max_bytes:
                    await cancel_body(response, "body exceeded configured limit")
                    raise HttpResponseTooLargeError(max_bytes)
            except ValueError:
                await cancel_body(response, "invalid content-length")
                return None
        body = await read_bounded_body(response, max_bytes)
        if body is None:
            raise HttpResponseTooLargeError(max_bytes)
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
