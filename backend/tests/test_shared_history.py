import json

import pytest
from pydantic import ValidationError
from test_rooms import NOW, FakeAdmission, FakeArchive, FakeGateway

from domain.rooms import Room, RoomError, message_history_key
from fastapi_app import MAX_REQUEST_BYTES
from room_models import CreateRoomRequest
from services.rooms import RoomService, fresh_rounds


def test_history_key_matches_browser() -> None:
    assert message_history_key("abc") == "h:ba7816bf8f01cfea414140de"


def test_full_history_fits_existing_request_limit() -> None:
    request = CreateRoomRequest.model_validate(
        {
            "channel": "example",
            "name": "Host",
            "seenMessageKeys": [message_history_key(str(i)) for i in range(500)],
        }
    )
    assert len(request.model_dump_json(by_alias=True).encode()) < MAX_REQUEST_BYTES


@pytest.mark.parametrize("keys", [["raw-id"], ["h:" + "a" * 24] * 501])
def test_history_validation(keys: list[str]) -> None:
    with pytest.raises(ValidationError):
        CreateRoomRequest.model_validate(
            {"channel": "example", "name": "Host", "seenMessageKeys": keys}
        )


@pytest.mark.asyncio
async def test_host_history_excludes_quotes_from_creation_and_rematches() -> None:
    keys = [message_history_key(f"private-author-id-{i}") for i in range(10)]
    gateway = FakeGateway()
    service = RoomService(FakeArchive(20), gateway, lambda: NOW, admission=FakeAdmission())
    request = CreateRoomRequest.model_validate(
        {"channel": "example", "name": "Host", "roundCount": 5, "seenMessageKeys": keys}
    )
    result = await service.create(request, "creator")
    room = Room.from_json(gateway.states[result["room"]["code"]])
    assert room.players[0].seen_message_keys == keys
    assert all(item.history_key not in keys for item in room.rounds)
    assert "host_seen_message_keys" not in json.dumps(result)
    rematch = await fresh_rounds(room, FakeArchive(20))
    assert all(item.history_key not in keys for item in rematch)
    assert {item.text for item in rematch}.isdisjoint(item.text for item in room.rounds)
    room.round_index = 0
    room.phase = "round"
    snapshot = room.snapshot(room.players[0], NOW)
    assert snapshot["round"] is not None
    assert snapshot["round"].get("historyKey") == room.rounds[0].history_key
    assert "author" not in snapshot["round"]
    assert "private-author-id" not in json.dumps(snapshot)
    with pytest.raises(RoomError, match="Not enough fresh"):
        await RoomService(FakeArchive(14), FakeGateway(), admission=FakeAdmission()).create(
            request, "creator"
        )
