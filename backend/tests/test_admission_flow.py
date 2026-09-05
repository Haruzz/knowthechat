"""Admission failures and RPC races must preserve room state and avoid archive work."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.types import Receive, Scope, Send
from test_room_runtime import Storage
from test_room_runtime import runtime as runtime
from test_rooms import NOW, FakeAdmission, FakeArchive, FakeGateway, make_room

from api_models import PublicArchiveRequest, PublicArchiveResponse
from domain.rooms import ROOM_LIFETIME_MS, Room, RoomError, token_hash
from fastapi_app import BoundedRequestBodyMiddleware, create_app
from room_models import CreateRoomRequest
from services import rooms as room_service_module
from services.rooms import RoomService, decode_result


def create_request() -> CreateRoomRequest:
    return CreateRoomRequest.model_validate({"channel": "haruzz", "name": "Host", "roundCount": 5})


@pytest.mark.asyncio
async def test_quota_denial_happens_before_fetching_or_creating_any_room() -> None:
    admission, archive, gateway = FakeAdmission(), FakeArchive(), FakeGateway()
    admission.failure = RoomError("All rooms are busy.", 429, 15)
    service = RoomService(archive, gateway, lambda: NOW, admission=admission)
    with pytest.raises(RoomError) as failure:
        await service.create(create_request(), token_hash("creator"))
    assert failure.value.status == 429
    assert failure.value.retry_after == 15
    assert archive.calls == 0
    assert not gateway.states
    assert not admission.reservations


@pytest.mark.asyncio
async def test_preparation_failures_release_slot_and_preserve_the_single_reservation() -> None:
    admission, archive, gateway = FakeAdmission(), FakeArchive(4), FakeGateway()
    service = RoomService(archive, gateway, lambda: NOW, admission=admission)
    with pytest.raises(RoomError, match="Not enough chat"):
        await service.create(create_request(), token_hash("creator"))
    assert len(admission.reservations) == 1
    assert admission.releases == [admission.reservations[0].id]
    assert archive.calls == 1
    assert not gateway.states


class SlowArchive(FakeArchive):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()

    async def execute(self, request: PublicArchiveRequest) -> PublicArchiveResponse:
        self.calls += 1
        self.started.set()
        await asyncio.Event().wait()
        raise AssertionError("A stalled archive cannot finish")


@pytest.mark.asyncio
async def test_archive_timeout_releases_slot_and_returns_retryable_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admission, archive, gateway = FakeAdmission(), SlowArchive(), FakeGateway()
    original_timeout = asyncio.timeout
    monkeypatch.setattr(
        room_service_module.asyncio, "timeout", lambda _seconds: original_timeout(0)
    )
    service = RoomService(archive, gateway, lambda: NOW, admission=admission)
    with pytest.raises(RoomError) as failure:
        await service.create(create_request(), token_hash("creator"))
    assert failure.value.status == 503
    assert failure.value.retry_after == 15
    assert admission.releases == [admission.reservations[0].id]
    assert not gateway.states


@pytest.mark.asyncio
async def test_cancelling_archive_preparation_releases_its_pending_slot() -> None:
    admission, archive, gateway = FakeAdmission(), SlowArchive(), FakeGateway()
    service = RoomService(archive, gateway, lambda: NOW, admission=admission)
    pending = asyncio.create_task(service.create(create_request(), token_hash("creator")))
    await archive.started.wait()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert admission.releases == [admission.reservations[0].id]
    assert not gateway.states


@pytest.mark.asyncio
async def test_ambiguous_initialize_keeps_lease_for_maybe_committed_room() -> None:
    class AmbiguousGateway(FakeGateway):
        async def initialize(self, code: str, state: str) -> None:
            self.states[code] = state
            raise RoomError("RPC response lost after commit.", 503)

    admission, gateway = FakeAdmission(), AmbiguousGateway()
    service = RoomService(FakeArchive(), gateway, lambda: NOW, admission=admission)
    with pytest.raises(RoomError) as failure:
        await service.create(create_request(), token_hash("creator"))
    assert failure.value.status == 503
    assert len(gateway.states) == 1
    assert not admission.releases
    room = Room.from_json(next(iter(gateway.states.values())))
    assert room.admission_id == admission.reservations[0].id


@pytest.mark.asyncio
async def test_exhausted_code_collisions_release_one_preparation_reservation() -> None:
    class CollisionGateway(FakeGateway):
        async def initialize(self, code: str, state: str) -> None:
            raise RoomError("Code already exists.", 409)

    admission = FakeAdmission()
    service = RoomService(FakeArchive(), CollisionGateway(), lambda: NOW, admission=admission)
    with pytest.raises(RoomError, match="Could not create"):
        await service.create(create_request(), token_hash("creator"))
    assert len(admission.reservations) == 1
    assert admission.releases == [admission.reservations[0].id]


@pytest.mark.asyncio
async def test_http_capacity_response_exposes_retry_after_and_does_not_fetch_chat() -> None:
    admission, archive = FakeAdmission(), FakeArchive()
    admission.failure = RoomError("All rooms are busy.", 429, 15)
    app = BoundedRequestBodyMiddleware(create_app(archive, FakeGateway(), admission))
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/api/rooms", json={"channel": "haruzz", "name": "Host", "roundCount": 5}
        )
    assert response.status_code == 429
    assert response.json() == {"error": "All rooms are busy.", "retryAfter": 15}
    assert response.headers["retry-after"] == "15"
    assert response.headers["cache-control"] == "no-store"
    assert archive.calls == 0


@pytest.mark.asyncio
async def test_http_creator_identity_normalizes_ip_hashes_and_ignores_forwarded_for() -> None:
    admission = FakeAdmission()
    app = BoundedRequestBodyMiddleware(create_app(FakeArchive(), FakeGateway(), admission))
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        for headers in (
            {"CF-Connecting-IP": "2001:0db8:0:0:0:0:0:1"},
            {"CF-Connecting-IP": "2001:db8::1", "X-Forwarded-For": "192.0.2.5"},
            {"X-Forwarded-For": "192.0.2.5"},
        ):
            response = await client.post(
                "/api/rooms", json={"channel": "haruzz", "name": "Host"}, headers=headers
            )
            assert response.status_code == 200
    assert admission.creator_keys == [
        token_hash("2001:db8::1"),
        token_hash("2001:db8::1"),
        token_hash("127.0.0.1"),
    ]


@pytest.mark.asyncio
async def test_http_duplicate_or_invalid_cloudflare_client_headers_fail_closed() -> None:
    admission, archive = FakeAdmission(), FakeArchive()
    app = BoundedRequestBodyMiddleware(create_app(archive, FakeGateway(), admission))
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        for headers in (
            [("CF-Connecting-IP", "192.0.2.1"), ("CF-Connecting-IP", "192.0.2.2")],
            [("CF-Connecting-IP", "192.0.2.1, 192.0.2.2")],
            [("CF-Connecting-IP", "unverified")],
        ):
            response = await client.post(
                "/api/rooms", json={"channel": "haruzz", "name": "Host"}, headers=headers
            )
            assert response.status_code == 503
    assert not admission.creator_keys
    assert archive.calls == 0


def pause_match_admission(
    module: Any, monkeypatch: pytest.MonkeyPatch, expected_calls: int = 1
) -> tuple[asyncio.Event, asyncio.Event]:
    entered, resume = asyncio.Event(), asyncio.Event()
    original = module.admission.admit_match
    calls = 0

    async def pending(lease_id: str, match_number: int) -> None:
        nonlocal calls
        calls += 1
        if calls >= expected_calls:
            entered.set()
        await resume.wait()
        await original(lease_id, match_number)

    monkeypatch.setattr(module.admission, "admit_match", pending)
    return entered, resume


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["start", "rematch"])
async def test_racing_start_or_rematch_commits_once_and_reuses_its_admission_ticket(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    module, _storage = runtime
    room, host, _guest = make_room()
    if action == "rematch":
        room.phase = "finished"
        room.round_index = len(room.rounds) - 1
        room.players[0].score = 9_000
    decode_result(await module.instance.initialize(room.to_json()))
    entered, resume = pause_match_admission(module, monkeypatch, expected_calls=2)
    pending = [
        asyncio.create_task(module.instance.command(action, host, "{}")) for _request in range(2)
    ]
    await entered.wait()
    resume.set()
    responses = [json.loads(value) for value in await asyncio.gather(*pending)]
    assert sum("result" in response for response in responses) == 1
    assert [response["status"] for response in responses if "error" in response] == [409]
    ticket = (room.admission_id, int(action == "rematch"))
    assert module.admission.match_calls == [ticket, ticket]
    assert module.admission.matches == {ticket}
    saved: Room = module.instance._load()
    assert saved.phase == ("waiting" if action == "rematch" else "round")
    if action == "rematch":
        assert saved.match_number == 1
        decode_result(await module.instance.command("start", host, "{}"))
        assert module.admission.matches == {ticket}


@pytest.mark.asyncio
async def test_join_during_match_admission_is_preserved_when_start_resumes(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, _storage = runtime
    room, host, _guest = make_room()
    await module.instance.initialize(room.to_json())
    entered, resume = pause_match_admission(module, monkeypatch)
    start = asyncio.create_task(module.instance.command("start", host, "{}"))
    await entered.wait()
    decode_result(await module.instance.command("join", "", '{"name":"New guest"}'))
    resume.set()
    decode_result(await start)
    saved: Room = module.instance._load()
    assert saved.phase == "round"
    assert [player.name for player in saved.players] == ["Host", "Guest", "New guest"]


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["host", "guest"])
async def test_leave_during_admission_revalidates_host_and_player_count(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch, who: str
) -> None:
    module, _storage = runtime
    room, host, guest = make_room()
    await module.instance.initialize(room.to_json())
    entered, resume = pause_match_admission(module, monkeypatch)
    start = asyncio.create_task(module.instance.command("start", host, "{}"))
    await entered.wait()
    decode_result(await module.instance.command("leave", host if who == "host" else guest, "{}"))
    resume.set()
    response = json.loads(await start)
    assert response["status"] == (401 if who == "host" else 409)
    saved: Room = module.instance._load()
    assert saved.phase == "waiting"
    assert len(saved.players) == 1
    assert saved.host_id == saved.players[0].id


@pytest.mark.asyncio
async def test_denied_rematch_preserves_finished_scores_and_returns_retry_after(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    room, host, _guest = make_room()
    room.phase = "finished"
    room.round_index = 4
    room.players[0].score = 9_000
    await module.instance.initialize(room.to_json())
    before = module.instance._load().to_json()
    module.admission.failure = RoomError("Daily match limit reached.", 429, 600)
    response = json.loads(await module.instance.command("rematch", host, "{}"))
    assert response["status"] == 429
    assert response["retryAfter"] == 600
    assert module.instance._load().to_json() == before
    assert not module.admission.match_calls


@pytest.mark.asyncio
async def test_controller_outage_does_not_interrupt_guesses_or_leaving_an_existing_game(
    runtime: tuple[Any, Storage],
) -> None:
    module, storage = runtime
    room, host, guest = make_room()
    await module.instance.initialize(room.to_json())
    decode_result(await module.instance.command("start", host, "{}"))
    module.admission.failure = RoomError("Controller unavailable.", 503)
    decode_result(
        await module.instance.command("guess", host, '{"roundId":"round-0","choice":"chatter_a"}')
    )
    decode_result(await module.instance.command("leave", guest, "{}"))
    assert module.instance._load().phase == "reveal"
    assert module.instance._load().players[0].score == 1_500
    decode_result(await module.instance.command("leave", host, "{}"))
    assert module.instance._load() is None
    assert storage.deletions == 1
    assert module.admission.matches == {(room.admission_id, 0)}


@pytest.mark.asyncio
async def test_initialize_retry_is_idempotent_and_expiry_releases_the_same_lease(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    room, _host, _guest = make_room()
    decode_result(await module.instance.initialize(room.to_json()))
    decode_result(await module.instance.initialize(room.to_json()))
    assert module.admission.activations == [(room.admission_id, room.expires_at)]
    assert module.instance._load().revision == 1
    monkeypatch.setattr(module, "now_ms", lambda: NOW + ROOM_LIFETIME_MS)
    await module.instance.alarm()
    assert module.admission.releases == [room.admission_id]
    assert storage.deletions == 1


@pytest.mark.asyncio
async def test_last_leave_releases_capacity_before_returning_success(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    room, host, guest = make_room()
    await module.instance.initialize(room.to_json())
    decode_result(await module.instance.command("leave", guest, "{}"))
    assert not module.admission.releases
    decode_result(await module.instance.command("leave", host, "{}"))
    assert module.admission.releases == [room.admission_id]


@pytest.mark.asyncio
async def test_legacy_rooms_can_finish_a_round_but_cannot_bypass_match_admission(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    room, host, guest = make_room()
    room.admission_id = ""
    room.start(room.players[0], NOW)
    # Legacy state was persisted before admission existed and bypasses initialize only here.
    module.instance._save(room.to_json())
    for token in (host, guest):
        decode_result(
            await module.instance.command(
                "guess", token, '{"roundId":"round-0","choice":"chatter_a"}'
            )
        )
    assert module.instance._load().phase == "reveal"
    room = module.instance._load()
    room.phase = "finished"
    module.instance._save(room.to_json())
    assert json.loads(await module.instance.command("rematch", host, "{}"))["status"] == 409
    room.phase = "waiting"
    module.instance._save(room.to_json())
    assert json.loads(await module.instance.command("start", host, "{}"))["status"] == 409
    assert not module.admission.match_calls


@pytest.mark.asyncio
async def test_missing_local_client_information_uses_one_shared_admission_key() -> None:
    admission = FakeAdmission()
    application = BoundedRequestBodyMiddleware(create_app(FakeArchive(), FakeGateway(), admission))

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        scope.pop("client", None)
        await application(scope, receive, send)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://localhost:8788"
    ) as client:
        for headers in ({}, {"X-Forwarded-For": "192.0.2.5"}, {"X-Forwarded-For": "192.0.2.6"}):
            response = await client.post(
                "/api/rooms", json={"channel": "haruzz", "name": "Host"}, headers=headers
            )
            assert response.status_code == 200
    assert admission.creator_keys == [token_hash("unknown-client")] * 3


@pytest.mark.asyncio
async def test_missing_admission_binding_returns_retryable_error_without_fetching() -> None:
    archive = FakeArchive()
    application = BoundedRequestBodyMiddleware(create_app(archive, FakeGateway()))

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        scope["env"] = object()
        await application(scope, receive, send)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post("/api/rooms", json={"channel": "haruzz", "name": "Host"})
    assert response.status_code == 503
    assert response.json()["retryAfter"] == 15
    assert response.headers["retry-after"] == "15"
    assert archive.calls == 0
