from __future__ import annotations

import random
from collections.abc import Sequence

from domain.models import ArchiveDate


def date_key(date: ArchiveDate) -> str:
    return f"{date.year}-{date.month.zfill(2)}-{(date.day or '1').zfill(2)}"


def sample_even_dates(
    dates: Sequence[ArchiveDate], maximum: int, rng: random.Random | None = None
) -> list[ArchiveDate]:
    source = rng or random
    sorted_dates = sorted(dates, key=date_key)
    if len(sorted_dates) <= maximum:
        return sorted_dates
    earlier = sorted_dates[:-1]
    picked: list[ArchiveDate] = []
    for index in range(maximum - 1):
        start = index * len(earlier) // (maximum - 1)
        end = max(start + 1, (index + 1) * len(earlier) // (maximum - 1))
        bucket = earlier[start:end]
        picked.append(bucket[source.randrange(len(bucket))])
    return [*picked, sorted_dates[-1]]


def _js_round(value: float) -> int:
    return int(value + 0.5)


def sample_dates(
    dates: Sequence[ArchiveDate], maximum: int, rng: random.Random | None = None
) -> list[ArchiveDate]:
    source = rng or random
    by_month: dict[str, list[ArchiveDate]] = {}
    for date in dates:
        key = f"{date.year}-{date.month.zfill(2)}"
        by_month.setdefault(key, []).append(date)
    months = sorted(by_month.items())
    if len(months) <= maximum:
        selected = months
    else:
        selected = [
            months[_js_round(index * (len(months) - 1) / (maximum - 1))] for index in range(maximum)
        ]
    newest = max(dates, key=date_key)
    newest_month = f"{newest.year}-{newest.month.zfill(2)}"
    return [
        newest
        if index == len(selected) - 1 or month == newest_month
        else choices[source.randrange(len(choices))]
        for index, (month, choices) in enumerate(selected)
    ]
