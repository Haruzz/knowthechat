"""Exercise the shared admission ledger against SQLite, including concurrent RPCs."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from domain.admission import DAY_MS, MINUTE_MS, PENDING_LEASE_MS, Reservation
from domain.rooms import ROOM_LIFETIME_MS, RoomError, token_hash

NOW = 1_800_000_000_000


class Cursor:
    def __init__(self, cursor: sqlite3.Cursor) -> None:
        self.cursor = cursor

    def toArray(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.cursor.fetchall()]


class Storage:
    def __init__(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.sql = self
        self.alarm_at: int | None = None

    def exec(self, statement: str, *bindings: Any) -> Cursor:
        return Cursor(self.db.execute(statement, bindings))

    async def setAlarm(self, alarm_at: int) -> None:
        self.alarm_at = alarm_at
        # Allow concurrent calls to interleave once the actual storage work is done.
        await asyncio.sleep(0)

    async def deleteAlarm(self) -> None:
        self.alarm_at = None
        await asyncio.sleep(0)

    def count(self, table: str) -> int:
        return self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Storage]:
    class DurableObject:
        def __init__(self, ctx: Any, env: Any) -> None:
            self.ctx = ctx
            self.env = env

    workers = ModuleType("workers")
    workers.DurableObject = DurableObject  # pyright: ignore[reportAttributeAccessIssue]
    monkeypatch.setitem(sys.modules, "workers", workers)
    path = Path(__file__).parents[1] / "src" / "runtime" / "admission.py"
    spec = importlib.util.spec_from_file_location("tested_admission_runtime", path)
    assert spec is not None and spec.loader is not None
    module: Any = importlib.util.module_from_spec(spec)
    # Pydantic resolves TypedDict/dataclass annotations against the owning module.
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "now_ms", lambda: NOW)
    storage = Storage()
    module.context = SimpleNamespace(storage=storage)
    module.instance = module.RoomAdmission(module.context, SimpleNamespace())
    return module, storage


async def reserve(module: Any, creator: str = "creator") -> Reservation:
    result = module.decode_admission(await module.instance.reserve(token_hash(creator)))
    assert isinstance(result, Reservation)
    return result


@pytest.mark.asyncio
async def test_concurrent_creations_cannot_overbook_pending_or_active_slots(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    responses = [
        json.loads(result)
        for result in await asyncio.gather(
            *(module.instance.reserve(token_hash(str(number))) for number in range(40))
        )
    ]
    admitted = [result["result"] for result in responses if "result" in result]
    denied = [result for result in responses if "error" in result]
    assert len(admitted) == 10
    assert len(denied) == 30
    assert all(result["status"] == 429 and result["retryAfter"] == 15 for result in denied)
    assert storage.count("admission_preparations") == 10
    for lease in admitted[:5]:
        module.decode_admission(await module.instance.activate(lease["id"], NOW + ROOM_LIFETIME_MS))

    # Reconstruction retains authority; pending leases expire independently of rooms.
    module.instance = module.RoomAdmission(module.context, SimpleNamespace())
    monkeypatch.setattr(module, "now_ms", lambda: NOW + PENDING_LEASE_MS)
    await module.instance.alarm()
    assert storage.count("admission_leases") == 5
    assert storage.count("admission_preparations") == 10
    assert storage.count("admission_creations") == 0
    await reserve(module, "replacement")
    assert storage.count("admission_leases") == 6


@pytest.mark.asyncio
async def test_failed_preparations_release_capacity_but_consume_rolling_daily_allowance(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    module.instance = module.RoomAdmission(
        module.context, SimpleNamespace(ROOM_PREPARATIONS_PER_DAY="2", ROOM_MAX_OPEN="1")
    )
    first = await reserve(module, "first")
    module.decode_admission(await module.instance.release(first.id))
    module.decode_admission(await module.instance.release(first.id))
    monkeypatch.setattr(module, "now_ms", lambda: NOW + 10_000)
    second = await reserve(module, "second")
    module.decode_admission(await module.instance.release(second.id))
    assert storage.count("admission_leases") == 0
    assert storage.count("admission_preparations") == 2
    failure = json.loads(await module.instance.reserve(token_hash("third")))
    assert failure["status"] == 429
    assert failure["retryAfter"] == 86_390

    # Exactly one event leaves the rolling window, rather than resetting a UTC day.
    monkeypatch.setattr(module, "now_ms", lambda: NOW + DAY_MS)
    third = await reserve(module, "third")
    module.decode_admission(await module.instance.release(third.id))
    assert storage.count("admission_preparations") == 2
    again = json.loads(await module.instance.reserve(token_hash("fourth")))
    assert again["status"] == 429
    assert again["retryAfter"] == 10


@pytest.mark.asyncio
async def test_network_rate_limit_expires_and_never_retains_network_keys_in_daily_rows(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    for _attempt in range(3):
        lease = await reserve(module)
        await module.instance.release(lease.id)
    failure = json.loads(await module.instance.reserve(token_hash("creator")))
    assert failure["status"] == 429
    assert failure["retryAfter"] == 60
    assert storage.count("admission_preparations") == 3
    await reserve(module, "different network")
    daily_columns = {
        row["name"] for row in storage.exec("PRAGMA table_info(admission_preparations)").toArray()
    }
    assert daily_columns == {"id", "admitted_at"}
    monkeypatch.setattr(module, "now_ms", lambda: NOW + MINUTE_MS)
    await module.instance.alarm()
    assert storage.count("admission_creations") == 0
    await reserve(module)
    assert storage.count("admission_preparations") == 5


@pytest.mark.asyncio
async def test_activation_is_bounded_idempotent_and_expired_reservations_fail_closed(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    lease = await reserve(module)
    for expiry in (NOW, NOW + ROOM_LIFETIME_MS + 1, True, "tomorrow"):
        assert json.loads(await module.instance.activate(lease.id, expiry))["status"] == 400
    assert json.loads(await module.instance.admit_match(lease.id, 0))["status"] == 409
    expiry = NOW + MINUTE_MS
    module.decode_admission(await module.instance.activate(lease.id, expiry))
    module.decode_admission(await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS))
    stored = storage.exec("SELECT expires_at FROM admission_leases").toArray()[0]
    assert stored["expires_at"] == expiry
    monkeypatch.setattr(module, "now_ms", lambda: expiry)
    assert json.loads(await module.instance.activate(lease.id, expiry + MINUTE_MS))["status"] == 409
    assert json.loads(await module.instance.admit_match(lease.id, 0))["status"] == 409
    pending = await reserve(module, "late preparation")
    monkeypatch.setattr(module, "now_ms", lambda: pending.expires_at)
    assert (
        json.loads(
            await module.instance.activate(pending.id, pending.expires_at + ROOM_LIFETIME_MS)
        )["status"]
        == 409
    )
    assert storage.count("admission_leases") == 0


@pytest.mark.asyncio
async def test_initial_starts_rematches_and_retries_share_a_strict_match_allowance(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    module.instance = module.RoomAdmission(
        module.context, SimpleNamespace(ROOM_MATCHES_PER_DAY="2")
    )
    lease = await reserve(module)
    await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    results = await asyncio.gather(*(module.instance.admit_match(lease.id, 0) for _ in range(8)))
    assert all(module.decode_admission(result) is None for result in results)
    module.decode_admission(await module.instance.admit_match(lease.id, 1))
    module.decode_admission(await module.instance.admit_match(lease.id, 1))
    assert storage.count("admission_matches") == 2
    failure = json.loads(await module.instance.admit_match(lease.id, 2))
    assert failure["status"] == 429
    assert failure["retryAfter"] == 86_400
    assert json.loads(await module.instance.admit_match(lease.id, -1))["status"] == 400
    assert json.loads(await module.instance.admit_match(lease.id, True))["status"] == 400
    await module.instance.release(lease.id)
    assert storage.count("admission_matches") == 2
    assert json.loads(await module.instance.admit_match(lease.id, 0))["status"] == 409
    monkeypatch.setattr(module, "now_ms", lambda: NOW + DAY_MS)
    fresh = await reserve(module, "next day")
    await module.instance.activate(fresh.id, NOW + DAY_MS + ROOM_LIFETIME_MS)
    module.decode_admission(await module.instance.admit_match(fresh.id, 0))
    assert storage.count("admission_matches") == 1


@pytest.mark.asyncio
async def test_alarm_prunes_retained_rows_after_reconstruction_and_stops_when_empty(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    lease = await reserve(module)
    await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    await module.instance.admit_match(lease.id, 0)
    assert storage.alarm_at == NOW + MINUTE_MS
    restored = module.RoomAdmission(module.context, SimpleNamespace())
    monkeypatch.setattr(module, "now_ms", lambda: NOW + MINUTE_MS)
    await restored.alarm()
    assert storage.count("admission_creations") == 0
    assert storage.alarm_at == NOW + ROOM_LIFETIME_MS
    monkeypatch.setattr(module, "now_ms", lambda: NOW + ROOM_LIFETIME_MS)
    await restored.alarm()
    assert storage.count("admission_leases") == 0
    assert storage.alarm_at == NOW + DAY_MS
    monkeypatch.setattr(module, "now_ms", lambda: NOW + DAY_MS)
    await restored.alarm()
    assert storage.count("admission_preparations") == storage.count("admission_matches") == 0
    assert storage.alarm_at is None
    await reserve(module, "after cleanup")
    assert storage.alarm_at == NOW + DAY_MS + MINUTE_MS


@pytest.mark.asyncio
async def test_raw_ip_and_unbounded_rpc_inputs_are_rejected_without_reserving(
    runtime: tuple[Any, Storage],
) -> None:
    module, storage = runtime
    for key in ("127.0.0.1", "x" * 10_000, None, 42):
        assert json.loads(await module.instance.reserve(key))["status"] == 400
    assert storage.count("admission_leases") == 0
    assert storage.count("admission_preparations") == 0


@pytest.mark.asyncio
async def test_gateway_preserves_rejections_and_rejects_missing_or_malformed_success(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    seen_names: list[str] = []

    def get_by_name(name: str) -> Any:
        seen_names.append(name)
        return module.instance

    gateway = module.CloudflareAdmissionGateway(SimpleNamespace(getByName=get_by_name))
    lease = await gateway.reserve(token_hash("gateway"))
    await gateway.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    await gateway.admit_match(lease.id, 0)
    await gateway.release(lease.id)
    assert seen_names == ["lobbies"] * 4
    with pytest.raises(RoomError) as expired:
        await gateway.admit_match(lease.id, 0)
    assert expired.value.status == 409

    async def response(_creator_key: str) -> str:
        return '{"error":"Slow down","status":429,"retryAfter":12}'

    module.instance = SimpleNamespace(reserve=response)
    with pytest.raises(RoomError) as limited:
        await gateway.reserve(token_hash("gateway"))
    assert limited.value.status == 429
    assert limited.value.retry_after == 12

    for malformed in (
        "not json",
        '{"result":null}',
        '{"result":{"id":"short","expires_at":42}}',
        '{"result":{"id":"' + "a" * 32 + '","expires_at":"42"}}',
        '{"error":"Slow down","status":200}',
        "x" * 2_049,
    ):

        async def invalid(_creator_key: str, value: str = malformed) -> str:
            return value

        module.instance = SimpleNamespace(reserve=invalid)
        with pytest.raises(RoomError) as failure:
            await gateway.reserve(token_hash("gateway"))
        assert failure.value.status == 503

    async def unavailable(_creator_key: str) -> str:
        raise RuntimeError("RPC unavailable")

    module.instance = SimpleNamespace(reserve=unavailable)
    with pytest.raises(RoomError) as failure:
        await gateway.reserve(token_hash("gateway"))
    assert failure.value.status == 503
