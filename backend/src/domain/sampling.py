from __future__ import annotations

from collections.abc import Sequence

from domain.models import ArchiveDate


def date_key(date: ArchiveDate) -> str:
    return f"{date.year}-{date.month.zfill(2)}-{(date.day or '1').zfill(2)}"


def sample_even_dates(dates: Sequence[ArchiveDate], maximum: int) -> list[ArchiveDate]:
    sorted_dates = sorted(dates, key=date_key)
    if len(sorted_dates) <= maximum:
        return sorted_dates
    earlier = sorted_dates[:-1]
    picked: list[ArchiveDate] = []
    for index in range(maximum - 1):
        start = index * len(earlier) // (maximum - 1)
        end = max(start + 1, (index + 1) * len(earlier) // (maximum - 1))
        bucket = earlier[start:end]
        picked.append(bucket[(len(bucket) - 1) // 2])
    return [*picked, sorted_dates[-1]]
