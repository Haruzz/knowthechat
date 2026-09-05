from __future__ import annotations

import json

import pytest
from httpx import ASGITransport, AsyncClient

from api_models import ChatterResponse, PublicArchiveRequest, PublicArchiveResponse, QuoteResponse
from domain.admission import PENDING_LEASE_MS, Reservation
from domain.rooms import MAX_PLAYERS, PLAYER_IDLE_MS, ROOM_LIFETIME_MS, GameRound, Room, RoomError
from fastapi_app import MAX_REQUEST_BYTES, BoundedRequestBodyMiddleware, create_app
from room_models import CreateRoomRequest
from room_types import CommandPayload, CommandResult, RoomResult, snapshot_from_result
from services.room_commands import execute_command
from services.rooms import RoomService, decode_result, new_player, result_json

NOW = 1_800_000_000_000


def make_room(count: int = 5) -> tuple[Room, str, str]:
    host, host_token = new_player("Host", NOW)
    guest, guest_token = new_player("Guest", NOW)
    rounds = [
        GameRound(
            id=f"round-{index}",
            text=f"a perfectly ordinary chat message {index}",
            emotes=[],
            sent_at=NOW - 1_000_000,
            difficulty="easy",
            choices=["chatter_a", "chatter_b", "chatter_c"],
            author="chatter_a",
        )
        for index in range(count)
    ]
    return (
        Room(
            "ABC234",
            "haruzz",
            host.id,
            rounds,
            20,
            NOW + ROOM_LIFETIME_MS,
            [host, guest],
            admission_id="a" * 32,
        ),
        host_token,
        guest_token,
    )


def test_scores_answers_and_future_rounds_are_secret_until_reveal() -> None:
    room, host_token, guest_token = make_room()
    execute_command(room, "start", host_token, {}, NOW)
    state = execute_command(
        room, "guess", host_token, {"roundId": "round-0", "choice": "chatter_a"}, NOW + 1_000
    )
    assert state["phase"] == "round"
    assert state["round"] is not None
    assert "author" not in state["round"]
    assert "rounds" not in state
    assert state["players"][0]["choice"] == "chatter_a"
    assert state["players"][0]["score"] == 0
    assert state["players"][0]["streak"] == 0
    assert state["players"][0]["roundPoints"] == 0
    other_view = execute_command(room, "state", guest_token, {}, NOW + 1_100)
    assert other_view["players"][0]["answered"] is True
    assert other_view["players"][0]["choice"] is None
    assert host_token not in room.to_json()
    assert guest_token not in room.to_json()
    assert "token_hash" not in json.dumps(state)
    reveal = execute_command(
        room, "guess", guest_token, {"roundId": "round-0", "choice": "chatter_b"}, NOW + 2_000
    )
    assert reveal["phase"] == "reveal"
    assert reveal["round"] is not None and "author" in reveal["round"]
    assert reveal["round"]["author"] == "chatter_a"
    assert reveal["players"][0]["score"] == 1_475
    assert reveal["players"][0]["streak"] == 1
    assert reveal["players"][1]["score"] == 0
    assert reveal["players"][1]["streak"] == 0
    assert all(player["choice"] is not None for player in reveal["players"])


def test_server_deadline_rejects_late_guess_and_reveal_is_idempotent() -> None:
    room, host_token, guest_token = make_room()
    execute_command(room, "start", host_token, {}, NOW)
    execute_command(
        room, "guess", host_token, {"roundId": "round-0", "choice": "chatter_a"}, NOW + 19_000
    )
    with pytest.raises(RoomError, match="closed"):
        execute_command(
            room, "guess", guest_token, {"roundId": "round-0", "choice": "chatter_a"}, NOW + 20_000
        )
    assert room.phase == "reveal"
    assert room.players[0].score == 1_025
    assert room.players[1].score == 0
    room.advance(NOW + 20_100)
    room.reveal()
    assert room.players[0].score == 1_025


def test_full_match_and_rematch_reset_and_change_round_identifiers() -> None:
    room, host_token, guest_token = make_room()
    execute_command(room, "start", host_token, {}, NOW)
    for index in range(5):
        tick = NOW + index * 5_000
        for token in (host_token, guest_token):
            execute_command(
                room, "guess", token, {"roundId": f"round-{index}", "choice": "chatter_a"}, tick
            )
        assert room.phase == "reveal"
        execute_command(room, "next", host_token, {}, tick + 1_000)
    assert room.phase == "finished"
    assert room.players[0].streak == 5
    assert room.players[0].best_streak == 5
    assert room.players[0].score > 5_000
    old_ids = {item.id for item in room.rounds}
    state = execute_command(room, "rematch", host_token, {}, NOW + 30_000)
    assert state["phase"] == "waiting"
    assert state["round"] is None
    assert state["roundNumber"] == 0
    assert all(player["score"] == 0 and player["bestStreak"] == 0 for player in state["players"])
    assert not old_ids.intersection(item.id for item in room.rounds)
    assert all(len(item.choices) == 3 for item in room.rounds)


def test_host_permissions_and_one_guess_per_matching_round() -> None:
    room, host_token, guest_token = make_room()
    with pytest.raises(RoomError, match="Only the host"):
        execute_command(room, "start", guest_token, {}, NOW)
    execute_command(room, "start", host_token, {}, NOW)
    with pytest.raises(RoomError, match="different round"):
        execute_command(room, "guess", host_token, {"roundId": "old", "choice": "chatter_a"}, NOW)
    with pytest.raises(RoomError, match="three chatters"):
        execute_command(room, "guess", host_token, {"roundId": "round-0", "choice": "fake"}, NOW)
    execute_command(room, "guess", host_token, {"roundId": "round-0", "choice": "chatter_a"}, NOW)
    with pytest.raises(RoomError, match="already locked"):
        execute_command(
            room, "guess", host_token, {"roundId": "round-0", "choice": "chatter_b"}, NOW
        )
    with pytest.raises(RoomError, match="Wait for the round"):
        execute_command(room, "next", host_token, {}, NOW)


def test_join_limits_names_started_matches_and_host_transfer() -> None:
    room, host_token, guest_token = make_room()
    with pytest.raises(RoomError, match="already taken"):
        execute_command(room, "join", "", {"name": "host"}, NOW)
    for index in range(MAX_PLAYERS - 2):
        execute_command(room, "join", "", {"name": f"Player {index}"}, NOW)
    with pytest.raises(RoomError, match="full"):
        execute_command(room, "join", "", {"name": "Extra"}, NOW)
    execute_command(room, "leave", host_token, {}, NOW)
    assert room.host_id == room.authenticate(guest_token).id
    with pytest.raises(RoomError, match="session has expired"):
        execute_command(room, "state", host_token, {}, NOW)
    execute_command(room, "start", guest_token, {}, NOW)
    with pytest.raises(RoomError, match="already started"):
        execute_command(room, "join", "", {"name": "Late"}, NOW)


def test_start_requires_two_players_and_stale_host_transfers() -> None:
    room, host_token, guest_token = make_room()
    room.players[1].last_seen = NOW + PLAYER_IDLE_MS - 1_000
    room.advance(NOW + PLAYER_IDLE_MS)
    assert room.host_id == room.authenticate(guest_token).id
    with pytest.raises(RoomError, match="at least one friend"):
        execute_command(room, "start", guest_token, {}, NOW + PLAYER_IDLE_MS)
    with pytest.raises(RoomError, match="session has expired"):
        room.authenticate(host_token)


def test_persisted_room_restores_deadline_scores_and_tokens() -> None:
    room, host_token, guest_token = make_room()
    execute_command(room, "start", host_token, {}, NOW)
    execute_command(room, "guess", host_token, {"roundId": "round-0", "choice": "chatter_a"}, NOW)
    restored = Room.from_json(room.to_json())
    state = execute_command(restored, "state", guest_token, {}, NOW + 20_000)
    assert state["phase"] == "reveal"
    assert state["players"][0]["score"] == 1_500


class FakeArchive:
    def __init__(self, count: int = 20) -> None:
        self.count = count
        self.calls = 0

    async def execute(self, request: PublicArchiveRequest) -> PublicArchiveResponse:
        self.calls += 1
        names = ["chatter_a", "chatter_b", "chatter_c"]
        return PublicArchiveResponse(
            channel=request.channel,
            roomId="",
            chatters=[
                ChatterResponse(
                    id=name,
                    name=name,
                    messages=20,
                    sub=False,
                    vip=False,
                    mod=False,
                    activeDays=5,
                    activeMonths=2,
                    avgWords=5,
                    score=100,
                    avatar="CA",
                )
                for name in names
            ],
            quotes=[
                QuoteResponse(
                    id=f"private-author-id-{index}",
                    author=names[index % 3],
                    text=f"A quote for the guessing game {index}",
                    emotes=[],
                    sentAt=NOW - 1_000_000,
                    quality=80,
                    difficulty="easy",
                )
                for index in range(self.count)
            ],
            total=self.count,
            range=None,
            source="historical",
        )


class FakeAdmission:
    """A protocol fake; strict quotas themselves use real SQLite in admission tests."""

    def __init__(self) -> None:
        self.creator_keys: list[str] = []
        self.reservations: list[Reservation] = []
        self.activations: list[tuple[str, int]] = []
        self.releases: list[str] = []
        self.match_calls: list[tuple[str, int]] = []
        self.matches: set[tuple[str, int]] = set()
        self.failure: RoomError | None = None

    def _check(self) -> None:
        if self.failure is not None:
            raise self.failure

    async def reserve(self, creator_key: str) -> Reservation:
        self._check()
        self.creator_keys.append(creator_key)
        reservation = Reservation(f"{len(self.reservations) + 1:032x}", NOW + PENDING_LEASE_MS)
        self.reservations.append(reservation)
        return reservation

    async def activate(self, lease_id: str, expires_at: int) -> None:
        self._check()
        self.activations.append((lease_id, expires_at))

    async def release(self, lease_id: str) -> None:
        self._check()
        self.releases.append(lease_id)

    async def admit_match(self, lease_id: str, match_number: int) -> None:
        self._check()
        self.match_calls.append((lease_id, match_number))
        self.matches.add((lease_id, match_number))


class FakeGateway:
    def __init__(self) -> None:
        self.states: dict[str, str] = {}
        self.now = NOW

    async def initialize(self, code: str, state: str) -> None:
        if code in self.states:
            raise RoomError("Already exists.", 409)
        self.states[code] = state

    async def command(
        self, code: str, action: str, token: str, payload: CommandPayload
    ) -> CommandResult:
        if code not in self.states:
            raise RoomError("Lobby not found or expired.", 404)
        room = Room.from_json(self.states[code])
        # Simulate reconstruction from persisted state on every request.
        try:
            return execute_command(room, action, token, payload, self.now)
        finally:
            self.states[code] = room.to_json()


@pytest.mark.asyncio
async def test_create_uses_archive_service_and_bounds_server_generated_deck() -> None:
    archive, gateway = FakeArchive(), FakeGateway()
    service = RoomService(archive, gateway, lambda: NOW, admission=FakeAdmission())
    result = await service.create(
        CreateRoomRequest.model_validate({"channel": "haruzz", "name": "Host", "roundCount": 5}),
        "creator",
    )
    assert archive.calls == 1
    room = Room.from_json(gateway.states[result["room"]["code"]])
    assert len(room.rounds) == 5
    assert all(len(item.choices) == 3 and item.author in item.choices for item in room.rounds)
    assert all(not item.id.startswith("private-author-id") for item in room.rounds)
    assert result["room"]["round"] is None
    assert room.expires_at == NOW + ROOM_LIFETIME_MS
    with pytest.raises(RoomError, match="Not enough chat"):
        await RoomService(FakeArchive(4), gateway, admission=FakeAdmission()).create(
            CreateRoomRequest.model_validate(
                {"channel": "haruzz", "name": "Host", "roundCount": 5}
            ),
            "creator",
        )


@pytest.mark.asyncio
async def test_http_lifecycle_bearer_validation_and_no_store() -> None:
    archive, gateway = FakeArchive(), FakeGateway()
    app = BoundedRequestBodyMiddleware(create_app(archive, gateway, FakeAdmission()))
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        created = await client.post(
            "/api/rooms", json={"channel": "haruzz", "name": "Host", "roundCount": 5}
        )
        assert created.status_code == 200
        data = created.json()
        code = data["room"]["code"]
        host = {"Authorization": f"Bearer {data['token']}"}
        gateway.now = data["room"]["serverNow"]
        joined = await client.post(f"/api/rooms/{code.lower()}/join", json={"name": "Guest"})
        guest = {"Authorization": f"Bearer {joined.json()['token']}"}
        assert joined.status_code == 200
        assert (await client.get(f"/api/rooms/{code}")).status_code == 401
        assert (await client.get(f"/api/rooms/{code}?token={data['token']}")).status_code == 401
        denied = await client.post(f"/api/rooms/{code}/start", json={}, headers=guest)
        assert denied.status_code == 403
        started = await client.post(f"/api/rooms/{code}/start", json={}, headers=host)
        assert started.status_code == 200
        assert started.json()["phase"] == "round"
        assert "author" not in started.json()["round"]
        assert started.headers["cache-control"] == "no-store"
        invalid = await client.post(
            f"/api/rooms/{code}/guess",
            json={"roundId": started.json()["round"]["id"], "choice": "bad", "score": 99999},
            headers=host,
        )
        assert invalid.status_code == 400
        left = await client.post(f"/api/rooms/{code}/leave", json={}, headers=host)
        assert left.json() == {"ok": True}
        state = (await client.get(f"/api/rooms/{code}", headers=guest)).json()
        assert state["hostId"] == state["you"]
        assert (await client.get(f"/api/rooms/{code}", headers=host)).status_code == 401


@pytest.mark.asyncio
async def test_http_rejects_decks_bad_settings_cross_origin_and_large_bodies() -> None:
    archive, gateway = FakeArchive(), FakeGateway()
    app = BoundedRequestBodyMiddleware(create_app(archive, gateway, FakeAdmission()))
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        for extra in ({"roundCount": 100}, {"roundSeconds": 1}, {"rounds": []}, {"name": "   "}):
            invalid = await client.post(
                "/api/rooms", json={"channel": "haruzz", "name": "Host", **extra}
            )
            assert invalid.status_code == 400
        cross_origin = await client.post(
            "/api/rooms",
            json={"channel": "haruzz", "name": "Host"},
            headers={"Origin": "https://other.example"},
        )
        assert cross_origin.status_code == 403
        large = await client.post("/api/rooms", content=b"x" * (MAX_REQUEST_BYTES + 1))
        assert large.status_code == 413
        bad_code = await client.post("/api/rooms/invalid!code/join", json={"name": "Guest"})
        assert bad_code.status_code == 400
    assert archive.calls == 0
    assert gateway.states == {}


def test_persisted_room_typing_retains_legacy_defaults_and_optional_emotes() -> None:
    room, _host_token, _guest_token = make_room()
    room.rounds[0].emotes = [
        {"id": "25", "start": 0, "end": 4},
        {"id": "emote", "start": 5, "end": 10, "url": "https://example.com/emote.png"},
    ]
    persisted = json.loads(room.to_json())
    del persisted["revision"]
    restored = Room.from_json(json.dumps(persisted))
    assert restored.revision == 0
    assert restored.rounds[0].emotes == room.rounds[0].emotes
    assert json.loads(restored.to_json()) == {**persisted, "revision": 0}


def test_typed_rpc_results_preserve_payloads_and_snapshot_identity() -> None:
    from pydantic import ValidationError

    room, token, _guest_token = make_room()
    snapshot = room.snapshot(room.players[0], NOW)
    results: list[RoomResult] = [
        snapshot,
        {"token": token, "room": snapshot},
        {"ok": True},
        {},
    ]
    for payload in results:
        assert decode_result(result_json(payload)) == payload
    assert snapshot_from_result(results[0]) is snapshot
    assert snapshot_from_result(results[1]) is snapshot
    assert snapshot_from_result(results[2]) is None
    assert snapshot_from_result(results[3]) is None
    with pytest.raises(RoomError, match="Expired"):
        decode_result(result_json(error=RoomError("Expired", 404)))
    with pytest.raises(ValidationError):
        decode_result('{"result":{"unrecognized":true}}')
