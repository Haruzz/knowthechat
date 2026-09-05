"""Fresh deck preparation must preserve the live lobby across failure and races."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from typing import Any

import pytest
from test_room_runtime import Storage
from test_room_runtime import runtime as runtime
from test_rooms import FakeArchive, make_room

from api_models import PublicArchiveRequest, PublicArchiveResponse
from domain.rooms import MAX_QUOTE_HISTORY, Room, RoomArchiveSettings, quote_key
from room_types import is_room_snapshot
from services.rooms import build_rounds, decode_result


async def finished(module: Any) -> tuple[Room, str, str]:
    room, host, guest = make_room()
    room.phase = "finished"
    room.round_index = 4
    room.players[0].score = 9_000
    room.archive_settings = RoomArchiveSettings(None, 2024, 25)
    decode_result(await module.instance.initialize(room.to_json()))
    return room, host, guest


class ControlledArchive(FakeArchive):
    def __init__(self) -> None:
        super().__init__(100)
        self.started = asyncio.Event()
        self.resume = asyncio.Event()
        self.failure: Exception | None = None
        self.requests: list[PublicArchiveRequest] = []

    async def execute(self, request: PublicArchiveRequest) -> PublicArchiveResponse:
        self.requests.append(request)
        self.started.set()
        await self.resume.wait()
        if self.failure is not None:
            raise self.failure
        return await super().execute(request)


@pytest.mark.asyncio
async def test_rematches_refetch_original_settings_and_exclude_earlier_match_texts(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    original, host, _guest = await finished(module)
    archive = ControlledArchive()
    archive.resume.set()
    module.archive = archive
    seen = {quote_key(item.text) for item in original.rounds}
    for number in (1, 2):
        response = decode_result(await module.instance.command("rematch", host, "{}"))
        current: Room = module.instance._load()
        assert current.code == original.code
        assert current.expires_at == original.expires_at
        assert [p.id for p in current.players] == [p.id for p in original.players]
        assert current.phase == "waiting" and current.match_number == number
        keys = {quote_key(item.text) for item in current.rounds}
        assert len(keys) == 5 and keys.isdisjoint(seen)
        seen.update(keys)
        assert all(player.score == 0 for player in current.players)
        assert "archive_settings" not in response and "used_quote_keys" not in response
        assert "rematch_attempt" not in response
        decode_result(await module.instance.command("start", host, "{}"))
        assert len(module.admission.matches) == number
        current = module.instance._load()
        current.phase = "finished"
        current.round_index = 4
        module.instance._save(current.to_json())
    assert archive.calls == 2
    assert all(request.channel == "haruzz" for request in archive.requests)
    assert all(request.archive_year == 2024 for request in archive.requests)
    assert all(request.range_days is None for request in archive.requests)
    assert all(request.chatter_pool == 25 for request in archive.requests)
    assert len(module.admission.rematch_calls) == 2


@pytest.mark.asyncio
async def test_duplicate_rematch_does_not_fetch_twice_and_guests_can_read_final_scores(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    _room, host, guest = await finished(module)
    module.archive = archive = ControlledArchive()
    pending = asyncio.create_task(module.instance.command("rematch", host, "{}"))
    await archive.started.wait()
    duplicate = json.loads(await module.instance.command("rematch", host, "{}"))
    assert duplicate["status"] == 409
    assert len(archive.requests) == 1
    assert len(module.admission.rematch_calls) == 1
    state = decode_result(await module.instance.command("state", guest, "{}"))
    assert is_room_snapshot(state)
    assert state["phase"] == "finished" and state["players"][0]["score"] == 9_000
    archive.resume.set()
    decode_result(await pending)
    assert module.instance._load().phase == "waiting"


@pytest.mark.asyncio
async def test_failed_archive_preserves_results_and_retry_consumes_a_new_preparation(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    original, host, _guest = await finished(module)
    module.archive = archive = ControlledArchive()
    archive.failure = RuntimeError("Unavailable upstream")
    archive.resume.set()
    failed = json.loads(await module.instance.command("rematch", host, "{}"))
    assert failed["status"] == 503 and failed["retryAfter"] == 15
    current: Room = module.instance._load()
    assert current.phase == "finished" and current.players[0].score == 9_000
    assert current.rounds == original.rounds
    assert current.rematch_attempt == "" and current.rematch_until == 0
    archive.failure = None
    decode_result(await module.instance.command("rematch", host, "{}"))
    assert len(module.admission.rematch_calls) == 2
    assert len(module.admission.matches) == 1
    assert module.admission.rematch_calls[0][1] != module.admission.rematch_calls[1][1]


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["host", "guest", "everyone"])
async def test_departures_during_fetch_are_not_overwritten(
    runtime: tuple[Any, Storage], who: str
) -> None:
    module, _storage = runtime
    original, host, guest = await finished(module)
    module.archive = archive = ControlledArchive()
    pending = asyncio.create_task(module.instance.command("rematch", host, "{}"))
    await archive.started.wait()
    if who in ("host", "everyone"):
        decode_result(await module.instance.command("leave", host, "{}"))
    if who in ("guest", "everyone"):
        decode_result(await module.instance.command("leave", guest, "{}"))
    archive.resume.set()
    response = json.loads(await pending)
    current: Room | None = module.instance._load()
    if who == "everyone":
        assert response["status"] == 404 and current is None
    else:
        assert current is not None and len(current.players) == 1
        assert current.rematch_attempt == ""
        if who == "host":
            assert response["status"] == 401
            assert current.phase == "finished" and current.rounds == original.rounds
            assert current.host_id == original.players[1].id
        else:
            assert "result" in response and current.phase == "waiting"


@pytest.mark.asyncio
async def test_cancellation_clears_preparation_and_keeps_scores(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    _original, host, _guest = await finished(module)
    module.archive = archive = ControlledArchive()
    pending = asyncio.create_task(module.instance.command("rematch", host, "{}"))
    await archive.started.wait()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    current: Room = module.instance._load()
    assert current.rematch_attempt == ""
    assert current.phase == "finished" and current.players[0].score == 9_000
    assert len(module.admission.rematch_calls) == 1


@pytest.mark.asyncio
async def test_expiry_during_fetch_does_not_resurrect_the_room(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, _storage = runtime
    room, host, _guest = await finished(module)
    module.archive = archive = ControlledArchive()
    pending = asyncio.create_task(module.instance.command("rematch", host, "{}"))
    await archive.started.wait()
    monkeypatch.setattr(module, "now_ms", lambda: room.expires_at)
    archive.resume.set()
    response = json.loads(await pending)
    assert response["status"] == 404
    assert module.instance._load() is None
    assert module.admission.releases == [room.admission_id]


@pytest.mark.asyncio
async def test_no_fresh_quotes_keeps_finished_match_and_legacy_rooms_need_settings(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    _room, host, _guest = await finished(module)
    archive = await module.archive.execute(
        PublicArchiveRequest.model_validate({"channel": "haruzz"})
    )
    current: Room = module.instance._load()
    current.used_quote_keys = [quote_key(quote.text) for quote in archive.quotes]
    module.instance._save(current.to_json())
    response = json.loads(await module.instance.command("rematch", host, "{}"))
    assert response["status"] == 422
    assert module.instance._load().players[0].score == 9_000
    current = module.instance._load()
    current.archive_settings = None
    module.instance._save(current.to_json())
    calls = module.archive.calls
    legacy = json.loads(await module.instance.command("rematch", host, "{}"))
    assert legacy["status"] == 409
    assert module.archive.calls == calls


@pytest.mark.asyncio
async def test_quote_filter_handles_text_duplicates_and_history_stays_bounded() -> None:
    archive = await FakeArchive(10).execute(
        PublicArchiveRequest.model_validate({"channel": "haruzz"})
    )
    first = archive.quotes[0]
    duplicate = first.model_copy(update={"text": f"  {first.text.upper()}   "})
    archive.quotes = [first, duplicate, *archive.quotes[1:]]
    rounds = build_rounds(archive, 5, {quote_key(first.text)})
    assert all(quote_key(item.text) != quote_key(first.text) for item in rounds)
    assert len({quote_key(item.text) for item in rounds}) == 5
    room, host, _guest = make_room()
    room.phase = "finished"
    room.used_quote_keys = [quote_key(str(index)) for index in range(MAX_QUOTE_HISTORY)]
    room.rematch(room.authenticate(host), [replace(item) for item in rounds])
    assert len(room.used_quote_keys) == MAX_QUOTE_HISTORY
    assert all(quote_key(item.text) in room.used_quote_keys for item in rounds)
