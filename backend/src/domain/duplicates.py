from __future__ import annotations

import math
from dataclasses import dataclass

OVERLAP_RATIO = 0.82


def significant_words(value: str) -> set[str]:
    return {word for word in value.split(" ") if len(word) > 2}


@dataclass(frozen=True, slots=True)
class _Fingerprint:
    text_length: int
    words: frozenset[str]


class NearDuplicateIndex:
    def __init__(self) -> None:
        self._accepted: list[_Fingerprint] = []
        self._postings: dict[str, list[int]] = {}

    def has_near_duplicate(self, value: str) -> bool:
        words = significant_words(value)
        if len(words) < 3:
            return True
        minimum_overlap = math.ceil(OVERLAP_RATIO * len(words))
        probe_count = len(words) - minimum_overlap + 1
        probes = sorted(words, key=lambda word: len(self._postings.get(word, ())))[:probe_count]
        candidates = {index for word in probes for index in self._postings.get(word, ())}
        for index in candidates:
            other = self._accepted[index]
            if abs(other.text_length - len(value)) > max(12, len(value) * 0.3):
                continue
            overlap = sum(word in other.words for word in words)
            if overlap / max(len(words), len(other.words)) >= OVERLAP_RATIO:
                return True
        return False

    def add(self, value: str) -> None:
        words = significant_words(value)
        index = len(self._accepted)
        self._accepted.append(_Fingerprint(len(value), frozenset(words)))
        for word in words:
            self._postings.setdefault(word, []).append(index)
