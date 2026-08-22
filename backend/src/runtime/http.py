from __future__ import annotations

import json
from typing import Any

# The `js` module exists only inside the Pyodide Worker runtime.
from js import AbortSignal  # pyright: ignore[reportMissingImports, reportAttributeAccessIssue]
from workers import fetch

from providers.protocols import HttpResponseTooLargeError


async def cancel_body(source: Any, reason: str) -> None:
    if source.body is None:
        return
    try:
        await source.body.cancel(reason)
    except Exception:
        pass


async def read_bounded_body(source: Any, maximum: int) -> bytearray | None:
    if source.body is None:
        return bytearray()
    reader = source.body.getReader()
    body = bytearray()
    while True:
        result = await reader.read()
        if result.done:
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
    ) -> Any | None:
        options: dict[str, Any] = {
            "headers": {"Accept": "application/json", "User-Agent": user_agent},
            "signal": AbortSignal.timeout(timeout_ms),
        }
        if cache_ttl is not None:
            options["cf"] = {"cacheEverything": True, "cacheTtl": cache_ttl}
        try:
            response = await fetch(url, **options)
        except Exception:
            return None
        if not response.ok:
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
