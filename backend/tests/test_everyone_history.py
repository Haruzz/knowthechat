from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from test_fresh_rematches import ControlledArchive
from test_room_runtime import Storage
from test_room_runtime import runtime as runtime
from test_rooms import FakeArchive, make_room
from test_service import FakeHistorical, make_message, service

from domain.rooms import Room, message_history_key
from room_types import is_room_snapshot
from services.public_archive import FreshArchiveRequest
from services.rooms import decode_result


async def lobby(module: Any) -> tuple[Room, str, str]:
    room, host, guest = make_room()
    room.shared_history = True
    room.requested_round_count = 5
    room.deck_needs_refresh = True
    for player in room.players:
        player.history_ready = True
    decode_result(await module.instance.initialize(room.to_json()))
    return room, host, guest


@pytest.mark.asyncio
async def test_every_player_history_filters_start_and_stays_private(
    runtime: tuple[Any, Storage],
) -> None:
    module, _ = runtime
    room, host, guest = await lobby(module)
    # Their histories differ; only the last five of 100 candidates are unseen by both.
    for token, indexes in ((host, range(50)), (guest, range(50, 95))):
        result = decode_result(
            await module.instance.command(
                "history",
                token,
                json.dumps(
                    {
                        "seenMessageKeys": [
                            message_history_key(f"private-author-id-{i}") for i in indexes
                        ],
                    }
                ),
            )
        )
        assert "seen_message_keys" not in json.dumps(result)
        assert "private-author-id" not in json.dumps(result)
    started = decode_result(await module.instance.command("start", host, "{}"))
    assert is_room_snapshot(started)
    assert started["phase"] == "round"
    current: Room = module.instance._load()
    expected = {message_history_key(f"private-author-id-{i}") for i in range(95, 100)}
    assert {item.history_key for item in current.rounds} == expected
    assert len(module.admission.rematch_calls) == 1
    assert module.archive.calls == 1
    assert room.expires_at == current.expires_at


@pytest.mark.asyncio
async def test_join_and_finished_game_require_history_before_preparation(
    runtime: tuple[Any, Storage],
) -> None:
    module, _ = runtime
    _room, host, guest = await lobby(module)
    joined = decode_result(await module.instance.command("join", "", '{"name":"Late"}'))
    denied = json.loads(await module.instance.command("start", host, "{}"))
    assert denied["status"] == 409 and "sync" in denied["error"]
    assert module.archive.calls == 0
    assert "token" in joined
    decode_result(
        await module.instance.command("history", joined["token"], '{"seenMessageKeys":[]}')
    )
    decode_result(await module.instance.command("start", host, "{}"))
    current: Room = module.instance._load()
    current.phase = "reveal"
    current.round_index = 4
    module.instance._save(current.to_json())
    result = decode_result(await module.instance.command("next", host, "{}"))
    assert is_room_snapshot(result)
    assert result.get("historiesReady") is False
    denied = json.loads(await module.instance.command("rematch", host, "{}"))
    assert denied["status"] == 409
    for token in (host, guest, joined["token"]):
        decode_result(await module.instance.command("history", token, '{"seenMessageKeys":[]}'))
    decode_result(await module.instance.command("rematch", host, "{}"))
    assert module.instance._load().phase == "waiting"


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["join", "history", "settings", "host_leaves"])
async def test_preparation_rechecks_group_and_settings(
    runtime: tuple[Any, Storage], change: str
) -> None:
    module, _ = runtime
    original, host, guest = await lobby(module)
    module.archive = archive = ControlledArchive()
    pending = asyncio.create_task(module.instance.command("start", host, "{}"))
    await archive.started.wait()
    duplicate = json.loads(await module.instance.command("start", host, "{}"))
    assert duplicate["status"] == 409
    if change == "join":
        decode_result(await module.instance.command("join", "", '{"name":"Late"}'))
    elif change == "history":
        decode_result(
            await module.instance.command(
                "history", guest, json.dumps({"seenMessageKeys": [message_history_key("new")]})
            )
        )
    elif change == "settings":
        decode_result(
            await module.instance.command(
                "settings",
                host,
                json.dumps({"channel": original.channel, "roundCount": 10, "archiveYear": 2024}),
            )
        )
    else:
        decode_result(await module.instance.command("leave", host, "{}"))
    archive.resume.set()
    result = json.loads(await pending)
    assert result["status"] in (401, 409)
    current: Room = module.instance._load()
    assert current.phase == "waiting"
    assert current.rounds == original.rounds
    assert current.rematch_attempt == ""


@pytest.mark.asyncio
async def test_exhaustion_can_recover_with_fewer_rounds_in_same_lobby(
    runtime: tuple[Any, Storage],
) -> None:
    module, _ = runtime
    room, host, guest = await lobby(module)
    module.archive = FakeArchive(7)
    settings = {"channel": room.channel, "roundCount": 20, "archiveYear": 2024}
    forbidden = json.loads(await module.instance.command("settings", guest, json.dumps(settings)))
    assert forbidden["status"] == 403
    decode_result(await module.instance.command("settings", host, json.dumps(settings)))
    denied = json.loads(await module.instance.command("start", host, "{}"))
    assert denied["status"] == 422
    assert "fewer rounds" in denied["error"] and "wider archive" in denied["error"]
    assert module.instance._load().rounds == room.rounds
    settings["roundCount"] = 5
    decode_result(await module.instance.command("settings", host, json.dumps(settings)))
    decode_result(await module.instance.command("start", host, "{}"))
    current: Room = module.instance._load()
    assert len(current.rounds) == 5 and current.phase == "round"
    assert current.code == room.code


@pytest.mark.asyncio
@pytest.mark.parametrize("exclude", [True, False])
async def test_archive_expands_based_on_fresh_capacity(exclude: bool) -> None:
    initial = [
        make_message(author * 100 + i, user_id=f"u{author}", name=f"User{author}")
        for author in range(25)
        for i in range(15)
    ]
    extra = [make_message(5000 + i, user_id=f"u{i % 3}", name=f"User{i % 3}") for i in range(25)]
    provider = FakeHistorical(initial, expansion_messages=extra)
    request = FreshArchiveRequest.model_validate(
        {
            "channel": "channel",
            "archiveYear": 2023,
            "chatterPool": 25,
            "seen_message_keys": [message_history_key(m.id) for m in initial] if exclude else [],
            "required_quotes": 20,
        }
    )
    response = await service(provider).execute(request)
    assert provider.sampling_passes == ([1, 2] if exclude else [1])
    assert len(response.quotes) >= 20
    assert all(message_history_key(q.id) not in request.seen_message_keys for q in response.quotes)
