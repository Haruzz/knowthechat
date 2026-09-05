"""Configuration must never turn a malformed limit into unlimited admission."""

from types import SimpleNamespace

import pytest

from domain.admission import AdmissionSettings, retry_seconds
from domain.rooms import RoomError


def test_default_and_configured_admission_limits_are_integer_values() -> None:
    assert AdmissionSettings.from_env(SimpleNamespace()) == AdmissionSettings(10, 100, 100, 3)
    assert AdmissionSettings.from_env(
        SimpleNamespace(
            ROOM_MAX_OPEN="2",
            ROOM_PREPARATIONS_PER_DAY="25",
            ROOM_MATCHES_PER_DAY="40",
            ROOM_CREATIONS_PER_MINUTE="1",
        )
    ) == AdmissionSettings(2, 25, 40, 1)


@pytest.mark.parametrize(
    "value", [None, True, 5, {}, "", "0", "-1", "1.5", " 10", "\uff11\uff10", "10001", "9" * 100]
)
@pytest.mark.parametrize(
    "name",
    [
        "ROOM_MAX_OPEN",
        "ROOM_PREPARATIONS_PER_DAY",
        "ROOM_MATCHES_PER_DAY",
        "ROOM_CREATIONS_PER_MINUTE",
    ],
)
def test_invalid_configuration_fails_closed(name: str, value: object) -> None:
    with pytest.raises(RoomError) as failure:
        AdmissionSettings.from_env(SimpleNamespace(**{name: value}))
    assert failure.value.status == 503


def test_retry_after_rounds_up_and_never_becomes_zero() -> None:
    assert retry_seconds(2_001, 1_000) == 2
    assert retry_seconds(2_000, 1_000) == 1
    assert retry_seconds(1_000, 1_000) == 1
