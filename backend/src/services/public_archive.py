from __future__ import annotations

import asyncio
import json
import math
import time
from collections.abc import Callable, Sequence
from typing import Any

from api_models import (
    ArchiveRangeResponse,
    ChatterResponse,
    EmoteResponse,
    PublicArchiveRequest,
    PublicArchiveResponse,
    QuoteResponse,
)
from domain.duplicates import NearDuplicateIndex
from domain.models import Message
from domain.parsing import parse_irc_message
from domain.ranking import rank_chatters
from domain.scoring import score_recognizability
from domain.text import add_third_party_spans
from providers.protocols import EmoteProvider, HistoricalArchiveProvider, RecentArchiveProvider

MAX_MESSAGES = 1_000
MIN_HISTORICAL_MESSAGES = 100


class NoPublicArchiveError(Exception):
    pass


class StructuredLogger:
    def __call__(self, event: str, **fields: Any) -> None:
        print(json.dumps({"event": event, **fields}, separators=(",", ":"), default=str))


class PublicArchiveService:
    def __init__(
        self,
        historical_provider: HistoricalArchiveProvider,
        recent_providers: Sequence[RecentArchiveProvider],
        emote_providers: Sequence[EmoteProvider],
        *,
        now_ms: Callable[[], float] | None = None,
        logger: Callable[..., None] | None = None,
    ) -> None:
        self._historical_provider = historical_provider
        self._recent_providers = tuple(recent_providers)
        self._emote_providers = tuple(emote_providers)
        self._now_ms = now_ms or (lambda: time.time() * 1000)
        self._logger = logger or StructuredLogger()

    async def execute(self, request: PublicArchiveRequest) -> PublicArchiveResponse:
        started = time.monotonic()
        cutoff = (
            self._now_ms() - request.range_days * 86_400_000
            if request.range_days is not None
            else 0
        )
        self._logger(
            "request_received",
            channel=request.channel,
            range_days=request.range_days,
            chatter_pool=request.chatter_pool,
        )
        historical = await self._load_historical(request, cutoff)
        self._logger("historical_fetch_complete", messages=len(historical))

        raw_recent: list[str] = []
        if len(historical) < MIN_HISTORICAL_MESSAGES:
            self._logger("recent_fallback_started", historical_messages=len(historical))
            batches = await asyncio.gather(
                *(
                    provider.fetch(request.channel, MAX_MESSAGES)
                    for provider in self._recent_providers
                ),
                return_exceptions=True,
            )
            raw_recent = [value for batch in batches if isinstance(batch, list) for value in batch]
            self._logger("recent_fallback_complete", raw_messages=len(raw_recent))
        if not raw_recent and not historical:
            raise NoPublicArchiveError("No public archive was found for that channel.")

        recent = [
            message
            for raw in raw_recent
            if len(raw) <= 2_000
            for message in [parse_irc_message(raw, now_ms=self._now_ms())]
            if message is not None
        ]
        parsed = [*historical, *recent]
        self._logger(
            "messages_parsed",
            historical=len(historical),
            recent=len(recent),
            total=len(parsed),
        )
        messages = self._deduplicate(parsed, cutoff)
        self._logger(
            "messages_filtered", accepted=len(messages), rejected=len(parsed) - len(messages)
        )

        room_id = next((message.room_id for message in messages if message.room_id), "")
        emotes = await self._load_emotes(room_id)
        self._logger("emotes_loaded", catalog_entries=len(emotes))
        ranked, eligible = rank_chatters(messages, request.chatter_pool)
        self._logger("chatters_ranked", eligible=len(ranked))

        chatters = [
            ChatterResponse(
                id=chatter.id,
                name=chatter.name,
                messages=chatter.messages,
                sub=chatter.sub,
                vip=chatter.vip,
                mod=chatter.mod,
                activeDays=chatter.active_days,
                activeMonths=chatter.active_months,
                avgWords=chatter.avg_words,
                score=chatter.score,
                avatar=chatter.name[:2].upper(),
            )
            for chatter in ranked
        ]
        quotes: list[QuoteResponse] = []
        for message in messages:
            if message.user_id not in eligible:
                continue
            quality, difficulty = score_recognizability(message.body)
            if quality < 4:
                continue
            spans = add_third_party_spans(message.body, message.emotes, emotes)
            quotes.append(
                QuoteResponse(
                    id=message.id,
                    author=message.name,
                    text=message.body,
                    emotes=[
                        EmoteResponse(id=span.id, start=span.start, end=span.end, url=span.url)
                        for span in spans
                    ],
                    sentAt=message.sent_at,
                    quality=quality,
                    difficulty=difficulty,
                )
            )
        self._logger("quotes_selected", quotes=len(quotes))
        dates = [message.sent_at for message in messages if math.isfinite(message.sent_at)]
        response = PublicArchiveResponse(
            channel=request.channel,
            roomId=room_id,
            chatters=chatters,
            quotes=quotes,
            total=len(messages),
            range=ArchiveRangeResponse(oldest=min(dates), newest=max(dates)) if dates else None,
        )
        self._logger(
            "response_complete",
            total=response.total,
            chatters=len(response.chatters),
            quotes=len(response.quotes),
            duration_ms=round((time.monotonic() - started) * 1000),
        )
        return response

    async def _load_historical(self, request: PublicArchiveRequest, cutoff: float) -> list[Message]:
        try:
            return await self._historical_provider.fetch(
                request.channel, cutoff, request.range_days
            )
        except Exception as error:
            self._logger("historical_fetch_failed", error_type=type(error).__name__)
            return []

    async def _load_emotes(self, room_id: str) -> dict[str, str]:
        if not room_id.isascii() or not room_id.isdigit():
            return {}
        payloads = await asyncio.gather(
            *(provider.fetch(room_id) for provider in self._emote_providers),
            return_exceptions=True,
        )
        catalog: dict[str, str] = {}
        for payload in payloads:
            if not isinstance(payload, dict):
                continue
            for name, url in payload.items():
                catalog.setdefault(name, url)
        return catalog

    @staticmethod
    def _deduplicate(messages: Sequence[Message], cutoff: float) -> list[Message]:
        seen_ids: set[str] = set()
        seen_text: set[str] = set()
        near_duplicates = NearDuplicateIndex()
        accepted: list[Message] = []
        for message in messages:
            if (
                message.sent_at < cutoff
                or message.id in seen_ids
                or message.normalized in seen_text
                or near_duplicates.has_near_duplicate(message.normalized)
            ):
                continue
            seen_ids.add(message.id)
            seen_text.add(message.normalized)
            near_duplicates.add(message.normalized)
            accepted.append(message)
        return sorted(accepted, key=lambda message: message.sent_at)
