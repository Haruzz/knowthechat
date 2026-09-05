"""Fresh rematches reserve archive work without allocating another lobby slot."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from test_admission_runtime import NOW, Storage, reserve
from test_admission_runtime import runtime as runtime

from domain.admission import DAY_MS
from domain.rooms import ROOM_LIFETIME_MS, RoomError


@pytest.mark.asyncio
async def test_concurrent_attempt_retries_charge_one_preparation_and_one_match(
    runtime: tuple[Any, Storage],
) -> None:
    module, storage = runtime
    lease = await reserve(module)
    await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    await module.instance.admit_match(lease.id, 0)
    responses = await asyncio.gather(
        *(module.instance.admit_rematch(lease.id, "a" * 32, 1) for _request in range(12))
    )
    assert all(module.decode_admission(response) is None for response in responses)
    assert storage.count("admission_preparations") == 2
    assert storage.count("admission_matches") == 2
    assert storage.count("admission_rematch_attempts") == 1
    assert storage.count("admission_leases") == 1
    assert storage.count("admission_creations") == 1
    module.decode_admission(await module.instance.admit_match(lease.id, 1))
    assert storage.count("admission_matches") == 2


@pytest.mark.asyncio
async def test_retrying_failed_archive_with_new_attempt_charges_preparation_only(
    runtime: tuple[Any, Storage],
) -> None:
    module, storage = runtime
    module.instance = module.RoomAdmission(
        module.context,
        SimpleNamespace(ROOM_PREPARATIONS_PER_DAY="3", ROOM_MATCHES_PER_DAY="2"),
    )
    lease = await reserve(module)
    await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    await module.instance.admit_match(lease.id, 0)
    module.decode_admission(await module.instance.admit_rematch(lease.id, "a" * 32, 1))
    # The fetch failed; another attempt needs a new preparation but shares match 1.
    module.decode_admission(await module.instance.admit_rematch(lease.id, "b" * 32, 1))
    assert storage.count("admission_preparations") == 3
    assert storage.count("admission_matches") == 2
    assert storage.count("admission_rematch_attempts") == 2
    # Both allowances are full, yet a lost admission response is safe to retry.
    module.decode_admission(await module.instance.admit_rematch(lease.id, "b" * 32, 1))
    denied = json.loads(await module.instance.admit_rematch(lease.id, "c" * 32, 1))
    assert denied["status"] == 429
    assert "chat preparation" in denied["error"]
    assert denied["retryAfter"] == 86_400
    assert storage.count("admission_preparations") == 3
    assert storage.count("admission_matches") == 2
    await module.instance.release(lease.id)
    assert storage.count("admission_preparations") == 3
    assert storage.count("admission_matches") == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("limited_setting", ["ROOM_PREPARATIONS_PER_DAY", "ROOM_MATCHES_PER_DAY"])
async def test_either_daily_denial_changes_neither_allowance(
    runtime: tuple[Any, Storage], limited_setting: str
) -> None:
    module, storage = runtime
    module.instance = module.RoomAdmission(
        module.context, SimpleNamespace(**{limited_setting: "1"})
    )
    lease = await reserve(module)
    await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    await module.instance.admit_match(lease.id, 0)
    denied = json.loads(await module.instance.admit_rematch(lease.id, "a" * 32, 1))
    assert denied["status"] == 429
    assert denied["retryAfter"] == 86_400
    assert storage.count("admission_preparations") == 1
    assert storage.count("admission_matches") == 1
    assert storage.count("admission_rematch_attempts") == 0
    assert storage.count("admission_leases") == 1


@pytest.mark.asyncio
async def test_concurrent_new_attempts_cannot_exceed_remaining_preparation_capacity(
    runtime: tuple[Any, Storage],
) -> None:
    module, storage = runtime
    module.instance = module.RoomAdmission(
        module.context, SimpleNamespace(ROOM_PREPARATIONS_PER_DAY="2")
    )
    lease = await reserve(module)
    await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    responses = [
        json.loads(response)
        for response in await asyncio.gather(
            *(
                module.instance.admit_rematch(lease.id, f"{number:032x}", 1)
                for number in range(1, 21)
            )
        )
    ]
    assert sum("result" in response for response in responses) == 1
    assert sum(response.get("status") == 429 for response in responses) == 19
    assert storage.count("admission_preparations") == 2
    assert storage.count("admission_matches") == 1
    assert storage.count("admission_rematch_attempts") == 1


@pytest.mark.asyncio
async def test_attempt_identity_cannot_be_reused_for_another_lease_match_or_room_creation(
    runtime: tuple[Any, Storage],
) -> None:
    module, storage = runtime
    first, second = await reserve(module, "first"), await reserve(module, "second")
    for lease in (first, second):
        await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    module.decode_admission(await module.instance.admit_rematch(first.id, "a" * 32, 1))
    assert json.loads(await module.instance.admit_rematch(second.id, "a" * 32, 1))["status"] == 409
    assert json.loads(await module.instance.admit_rematch(first.id, "a" * 32, 2))["status"] == 409
    assert json.loads(await module.instance.admit_rematch(first.id, first.id, 2))["status"] == 409
    assert storage.count("admission_preparations") == 3
    assert storage.count("admission_matches") == 1
    assert storage.count("admission_rematch_attempts") == 1


@pytest.mark.asyncio
async def test_rematch_validation_and_expired_or_pending_leases_fail_closed(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    lease = await reserve(module)
    assert json.loads(await module.instance.admit_rematch(lease.id, "a" * 32, 1))["status"] == 409
    await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    for attempt in (None, 1, "short", "a" * 10_000, "?" * 32):
        assert (
            json.loads(await module.instance.admit_rematch(lease.id, attempt, 1))["status"] == 400
        )
    for number in (None, True, -1, 2_147_483_648, "1"):
        assert (
            json.loads(await module.instance.admit_rematch(lease.id, "a" * 32, number))["status"]
            == 400
        )
    assert storage.count("admission_preparations") == 1
    assert storage.count("admission_matches") == 0
    module.decode_admission(await module.instance.admit_rematch(lease.id, "a" * 32, 1))
    monkeypatch.setattr(module, "now_ms", lambda: NOW + ROOM_LIFETIME_MS)
    assert json.loads(await module.instance.admit_rematch(lease.id, "a" * 32, 1))["status"] == 409
    assert storage.count("admission_leases") == 0


@pytest.mark.asyncio
async def test_rematch_schema_upgrade_preserves_counters_and_alarm_cleans_attempts(
    runtime: tuple[Any, Storage], monkeypatch: pytest.MonkeyPatch
) -> None:
    module, storage = runtime
    lease = await reserve(module)
    await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    await module.instance.admit_match(lease.id, 0)
    # Reconstruct a ledger created by the earlier admission implementation.
    storage.exec("DROP TABLE admission_rematch_attempts")
    restored = module.RoomAdmission(module.context, SimpleNamespace())
    assert storage.count("admission_preparations") == 1
    assert storage.count("admission_matches") == 1
    module.decode_admission(await restored.admit_rematch(lease.id, "a" * 32, 1))
    monkeypatch.setattr(module, "now_ms", lambda: NOW + DAY_MS)
    await restored.alarm()
    for table in ("admission_preparations", "admission_matches", "admission_rematch_attempts"):
        assert storage.count(table) == 0
    assert storage.alarm_at is None


@pytest.mark.asyncio
async def test_rematch_gateway_validates_success_and_preserves_retry_after(
    runtime: tuple[Any, Storage],
) -> None:
    module, _storage = runtime
    lease = await reserve(module)
    await module.instance.activate(lease.id, NOW + ROOM_LIFETIME_MS)
    gateway = module.CloudflareAdmissionGateway(
        SimpleNamespace(getByName=lambda _name: module.instance)
    )
    await gateway.admit_rematch(lease.id, "a" * 32, 1)

    async def denied(_lease: str, _attempt: str, _match: int) -> str:
        return '{"error":"Daily limit reached.","status":429,"retryAfter":300}'

    module.instance = SimpleNamespace(admit_rematch=denied)
    with pytest.raises(RoomError) as failure:
        await gateway.admit_rematch(lease.id, "b" * 32, 1)
    assert failure.value.status == 429
    assert failure.value.retry_after == 300

    async def invalid(_lease: str, _attempt: str, _match: int) -> str:
        return '{"result":{"id":"' + "a" * 32 + '","expires_at":42}}'

    module.instance = SimpleNamespace(admit_rematch=invalid)
    with pytest.raises(RoomError) as failure:
        await gateway.admit_rematch(lease.id, "b" * 32, 1)
    assert failure.value.status == 503
