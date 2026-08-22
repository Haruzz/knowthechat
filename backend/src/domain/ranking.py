from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import UTC, datetime

from domain.models import ChatterAggregate, Message, RankedChatter


def utc_day(timestamp_ms: float) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, UTC).date().isoformat()


def rank_chatters(
    messages: Sequence[Message], chatter_pool: int
) -> tuple[list[RankedChatter], set[str]]:
    archive_days = {utc_day(message.sent_at) for message in messages}
    by_user: dict[str, ChatterAggregate] = {}
    for message in messages:
        day = utc_day(message.sent_at)
        month = day[:7]
        word_count = len([word for word in message.normalized.split(" ") if word])
        aggregate = by_user.get(message.user_id)
        if aggregate is None:
            aggregate = ChatterAggregate(
                id=message.user_id,
                name=message.name,
                messages=1,
                sub=message.sub,
                vip=message.vip,
                mod=message.mod,
                days={day},
                months={month},
                total_words=word_count,
            )
            by_user[message.user_id] = aggregate
        else:
            aggregate.messages += 1
            aggregate.sub = aggregate.sub or message.sub
            aggregate.vip = aggregate.vip or message.vip
            aggregate.mod = aggregate.mod or message.mod
            aggregate.days.add(day)
            aggregate.months.add(month)
            aggregate.total_words += word_count
    minimum_days = 2 if len(archive_days) >= 3 else 1
    ranked = [
        RankedChatter(
            id=value.id,
            name=value.name,
            messages=value.messages,
            sub=value.sub,
            vip=value.vip,
            mod=value.mod,
            active_days=len(value.days),
            active_months=len(value.months),
            avg_words=math.floor(value.total_words / value.messages + 0.5),
            score=value.messages
            + len(value.days) * 4
            + len(value.months) * 6
            + int(value.sub)
            + int(value.vip) * 5
            + int(value.mod) * 3,
        )
        for value in by_user.values()
        if value.messages >= 3 and len(value.days) >= minimum_days
    ]
    ranked.sort(key=lambda chatter: chatter.score, reverse=True)
    selected = ranked[:chatter_pool]
    return selected, {chatter.id for chatter in selected}
