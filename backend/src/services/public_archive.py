from __future__ import annotations

import asyncio
import json
import math
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
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
from domain.scoring import difficulty_for_age, score_recognizability
from domain.text import add_third_party_spans
from providers.protocols import (
    ArchiveProviderUnavailableError,
    ArchiveTooLargeError,
    ArchiveYearUnavailableError,
    EmoteProvider,
    HistoricalArchiveNotFoundError,
    HistoricalArchiveProvider,
    RecentArchiveProvider,
)

MAX_MESSAGES = 1_000
MAX_HISTORICAL_MESSAGES_ACROSS_PASSES = 10_000
MAX_GAME_QUOTES = 500
MAX_QUOTES_PER_CHATTER = 15
MAX_RESPONSE_QUOTES_PER_CHATTER = 25


class NoPublicArchiveError(Exception):
    pass


class StructuredLogger:
    def __call__(self, event: str, **fields: Any) -> None:
        message = fields.pop("message", event)
        print(
            json.dumps(
                {"message": message, "event": event, **fields},
                separators=(",", ":"),
                default=str,
            )
        )


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
        summary: dict[str, Any] = {
            "channel": request.channel,
            "range_days": request.range_days,
            "archive_year": request.archive_year,
            "chatter_pool": request.chatter_pool,
        }
        try:
            response = await self._execute(request, summary)
        except NoPublicArchiveError as error:
            self._logger(
                "request_summary",
                message="Public archive request completed without an archive.",
                outcome="not_found",
                error=str(error),
                duration_ms=round((time.monotonic() - started) * 1000),
                **summary,
            )
            raise
        except Exception as error:
            self._logger(
                "request_summary",
                message="Public archive request failed.",
                outcome="error",
                error_type=type(error).__name__,
                duration_ms=round((time.monotonic() - started) * 1000),
                **summary,
            )
            raise

        self._logger(
            "request_summary",
            message="Public archive request completed.",
            outcome="success",
            duration_ms=round((time.monotonic() - started) * 1000),
            **summary,
        )
        return response

    async def _execute(
        self, request: PublicArchiveRequest, summary: dict[str, Any]
    ) -> PublicArchiveResponse:
        cutoff = (
            self._now_ms() - request.range_days * 86_400_000
            if request.range_days is not None
            else 0
        )
        historical, historical_archive_missing = await self._load_historical(
            request, cutoff, summary, sampling_pass=1
        )
        summary["initial_historical_messages"] = len(historical)
        summary["historical_archive_missing"] = historical_archive_missing

        raw_recent: list[str] = []
        current_year = datetime.fromtimestamp(self._now_ms() / 1_000, UTC).year
        recent_allowed = request.archive_year is None or request.archive_year == current_year
        if historical_archive_missing and recent_allowed:
            batches = await asyncio.gather(
                *(
                    provider.fetch(request.channel, MAX_MESSAGES)
                    for provider in self._recent_providers
                ),
                return_exceptions=True,
            )
            raw_recent = [value for batch in batches if isinstance(batch, list) for value in batch]
            summary["recent_provider_failures"] = sum(
                isinstance(batch, BaseException) for batch in batches
            )
            if batches and all(isinstance(batch, BaseException) for batch in batches):
                raise ArchiveProviderUnavailableError
        summary["recent_raw_messages"] = len(raw_recent)
        if not raw_recent and not historical:
            raise NoPublicArchiveError("No public archive was found for that channel.")

        selected_year_bounds = (
            (
                datetime(request.archive_year, 1, 1, tzinfo=UTC).timestamp() * 1_000,
                datetime(request.archive_year + 1, 1, 1, tzinfo=UTC).timestamp() * 1_000,
            )
            if request.archive_year is not None
            else None
        )
        recent = [
            message
            for raw in raw_recent
            if len(raw) <= 2_000
            for message in [parse_irc_message(raw, now_ms=self._now_ms())]
            if message is not None
            and (
                selected_year_bounds is None
                or selected_year_bounds[0] <= message.sent_at < selected_year_bounds[1]
            )
        ]
        parsed = [*historical, *recent]
        summary["recent_messages"] = len(recent)
        messages = self._deduplicate(parsed, cutoff)
        initial_capacity = self._playable_quote_capacity(messages, request.chatter_pool)
        target_capacity = min(MAX_GAME_QUOTES, request.chatter_pool * MAX_QUOTES_PER_CHATTER)
        summary["initial_playable_quotes"] = initial_capacity
        summary["target_playable_quotes"] = target_capacity
        expanded = False
        if historical and initial_capacity < target_capacity:
            try:
                extra, _ = await self._load_historical(request, cutoff, summary, sampling_pass=2)
                if extra:
                    historical = [*historical, *extra][:MAX_HISTORICAL_MESSAGES_ACROSS_PASSES]
                    parsed = [*historical, *recent]
                    messages = self._deduplicate(parsed, cutoff)
                    expanded = True
                summary["expanded_historical_messages"] = len(extra)
            except (ArchiveProviderUnavailableError, NoPublicArchiveError) as error:
                summary["expansion_error_type"] = type(error).__name__
        summary["historical_messages"] = len(historical)
        summary["expanded"] = expanded
        summary["parsed_messages"] = len(parsed)
        summary["accepted_messages"] = len(messages)
        summary["rejected_messages"] = len(parsed) - len(messages)

        room_id = next((message.room_id for message in messages if message.room_id), "")
        emotes = await self._load_emotes(room_id)
        summary["emote_catalog_entries"] = len(emotes)
        ranked, eligible = rank_chatters(messages, request.chatter_pool)
        summary["eligible_chatters"] = len(ranked)
        summary["playable_quotes"] = self._playable_quote_capacity(messages, request.chatter_pool)

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
        reference_ms = self._now_ms()
        quote_messages = self._select_quote_messages(messages, eligible)
        summary["retained_quote_candidates"] = len(quote_messages)
        for message, quality in quote_messages:
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
                    difficulty=difficulty_for_age(message.sent_at, reference_ms),
                )
            )
        dates = [message.sent_at for message in messages if math.isfinite(message.sent_at)]
        response = PublicArchiveResponse(
            channel=request.channel,
            roomId=room_id,
            chatters=chatters,
            quotes=quotes,
            total=len(messages),
            range=ArchiveRangeResponse(oldest=min(dates), newest=max(dates)) if dates else None,
            source="historical" if historical else "recent",
        )
        summary["response_messages"] = response.total
        summary["response_chatters"] = len(response.chatters)
        summary["response_quotes"] = len(response.quotes)
        return response

    async def _load_historical(
        self,
        request: PublicArchiveRequest,
        cutoff: float,
        summary: dict[str, Any],
        *,
        sampling_pass: int,
    ) -> tuple[list[Message], bool]:
        try:
            return (
                await self._historical_provider.fetch(
                    request.channel,
                    cutoff,
                    request.range_days,
                    request.archive_year,
                    sampling_pass,
                ),
                False,
            )
        except HistoricalArchiveNotFoundError as error:
            summary["historical_error_type"] = type(error).__name__
            current_year = datetime.fromtimestamp(self._now_ms() / 1_000, UTC).year
            if request.archive_year is not None and request.archive_year != current_year:
                raise NoPublicArchiveError(
                    f"No public archive is available for {request.archive_year}."
                ) from error
            return [], True
        except ArchiveYearUnavailableError as error:
            summary["historical_error_type"] = type(error).__name__
            raise NoPublicArchiveError(str(error)) from error
        except ArchiveTooLargeError as error:
            summary["historical_error_type"] = type(error).__name__
            raise NoPublicArchiveError(str(error)) from error
        except Exception as error:
            summary["historical_error_type"] = type(error).__name__
            if isinstance(error, ArchiveProviderUnavailableError):
                raise
            raise ArchiveProviderUnavailableError from error

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

    @staticmethod
    def _playable_quote_capacity(messages: Sequence[Message], chatter_pool: int) -> int:
        _, eligible = rank_chatters(messages, chatter_pool)
        by_chatter: dict[str, int] = {}
        for message in messages:
            if message.user_id in eligible and score_recognizability(message.body) >= 4:
                by_chatter[message.user_id] = min(
                    MAX_QUOTES_PER_CHATTER, by_chatter.get(message.user_id, 0) + 1
                )
        return sum(by_chatter.values())

    @staticmethod
    def _select_quote_messages(
        messages: Sequence[Message], eligible: set[str]
    ) -> list[tuple[Message, int]]:
        by_chatter: dict[str, list[tuple[Message, int]]] = {}
        for message in messages:
            if message.user_id not in eligible:
                continue
            quality = score_recognizability(message.body)
            if quality >= 4:
                by_chatter.setdefault(message.user_id, []).append((message, quality))

        selected: list[tuple[Message, int]] = []
        for candidates in by_chatter.values():
            bucket_count = min(len(candidates), MAX_RESPONSE_QUOTES_PER_CHATTER)
            for index in range(bucket_count):
                bucket = candidates[
                    index * len(candidates) // bucket_count : (index + 1)
                    * len(candidates)
                    // bucket_count
                ]
                selected.append(
                    max(bucket, key=lambda candidate: (candidate[1], candidate[0].sent_at))
                )
        return sorted(selected, key=lambda candidate: candidate[0].sent_at)
