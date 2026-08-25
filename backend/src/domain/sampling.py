from __future__ import annotations

from collections.abc import Sequence

from domain.models import ArchiveDate


def date_key(date: ArchiveDate) -> str:
    return f"{date.year}-{date.month.zfill(2)}-{(date.day or '1').zfill(2)}"


def sample_even_dates(dates: Sequence[ArchiveDate], maximum: int) -> list[ArchiveDate]:
    return [bucket[(len(bucket) - 1) // 2] for bucket in date_buckets(dates, maximum)]


def date_buckets(dates: Sequence[ArchiveDate], maximum: int) -> list[list[ArchiveDate]]:
    """Split available dates into deterministic chronological sections."""
    if maximum <= 0:
        return []
    sorted_dates = sorted(dates, key=date_key)
    bucket_count = min(len(sorted_dates), maximum)
    return [
        sorted_dates[
            index * len(sorted_dates) // bucket_count : (index + 1)
            * len(sorted_dates)
            // bucket_count
        ]
        for index in range(bucket_count)
    ]
