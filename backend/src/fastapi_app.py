from __future__ import annotations

from typing import Protocol

from fastapi import FastAPI, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException as StarletteHttpException
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from api_models import ErrorResponse, PublicArchiveRequest, PublicArchiveResponse
from services.public_archive import NoPublicArchiveError

MAX_REQUEST_BYTES = 16_384
NO_STORE = {"Cache-Control": "no-store"}


class ArchiveService(Protocol):
    async def execute(self, request: PublicArchiveRequest) -> PublicArchiveResponse: ...


def _error_response(
    message: str, status: int, headers: dict[str, str] | None = None
) -> JSONResponse:
    body = ErrorResponse(error=message).model_dump()
    return JSONResponse(body, status_code=status, headers={**NO_STORE, **(headers or {})})


class BoundedRequestBodyMiddleware:
    """Buffer only the small API request body before FastAPI parses it."""

    def __init__(self, app: ASGIApp, maximum: int = MAX_REQUEST_BYTES) -> None:
        self.app = app
        self.maximum = maximum

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] != "POST"
            or scope["path"] != "/api/public-archive"
        ):
            await self.app(scope, receive, send)
            return

        raw_length = Headers(scope=scope).get("content-length")
        if raw_length:
            try:
                if int(raw_length) > self.maximum:
                    await _error_response("Request body is too large.", 413)(scope, receive, send)
                    return
            except ValueError:
                await _error_response("Enter a valid Twitch channel name.", 400)(
                    scope, receive, send
                )
                return

        messages: list[Message] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            messages.append(message)
            size += len(message.get("body", b""))
            if size > self.maximum:
                await _error_response("Request body is too large.", 413)(scope, receive, send)
                return
            if not message.get("more_body", False):
                break

        index = 0

        async def replay_receive() -> Message:
            nonlocal index
            if index >= len(messages):
                return {"type": "http.disconnect"}
            message = messages[index]
            index += 1
            return message

        await self.app(scope, replay_receive, send)


def create_app(service: ArchiveService) -> FastAPI:
    app = FastAPI(
        title="Know The Chat API",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return _error_response("Enter a valid Twitch channel name.", 400)

    @app.exception_handler(NoPublicArchiveError)
    async def no_archive(_request: Request, error: NoPublicArchiveError) -> JSONResponse:
        return _error_response(str(error), 404)

    @app.exception_handler(StarletteHttpException)
    async def http_error(_request: Request, error: StarletteHttpException) -> JSONResponse:
        headers = dict(error.headers or {})
        if error.status_code == 405:
            return _error_response("Method not allowed.", 405, headers)
        if error.status_code == 404:
            return _error_response("Not found.", 404, headers)
        return _error_response(str(error.detail), error.status_code, headers)

    @app.post(
        "/api/public-archive",
        response_model=PublicArchiveResponse,
        responses={
            400: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
            413: {"model": ErrorResponse},
        },
    )
    async def public_archive(
        payload: PublicArchiveRequest, response: Response
    ) -> PublicArchiveResponse:
        response.headers.update(NO_STORE)
        return await service.execute(payload)

    return app
