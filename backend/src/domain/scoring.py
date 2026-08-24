from __future__ import annotations

import re
from typing import Literal

from domain.text import normalize_message

DAY_MS = 86_400_000


def score_recognizability(body: str) -> int:
    words = [word for word in normalize_message(body).split(" ") if word]
    unique_ratio = len(set(words)) / max(len(words), 1)
    average_word_length = sum(map(len, words)) / max(len(words), 1)
    score = 2 if 6 <= len(words) <= 28 else 1
    if 10 <= len(words) <= 35:
        score += 1
    if unique_ratio >= 0.72:
        score += 1
    if re.search(r"[?!]", body):
        score += 1
    if re.search(r"[,;:\u2014\u2013]", body):
        score += 1
    if average_word_length >= 4.5 or any(len(word) >= 10 for word in words):
        score += 1
    if any(character.isnumeric() for character in body) or re.search(
        r'["\u201c\u201d\'\u2018\u2019()]', body
    ):
        score += 1
    if unique_ratio < 0.5:
        score -= 2
    return score


def difficulty_for_age(sent_at_ms: float, now_ms: float) -> Literal["easy", "medium", "hard"]:
    age_ms = max(0, now_ms - sent_at_ms)
    if age_ms < 30 * DAY_MS:
        return "easy"
    if age_ms <= 180 * DAY_MS:
        return "medium"
    return "hard"
