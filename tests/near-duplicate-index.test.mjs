import assert from "node:assert/strict";
import test from "node:test";

import { NearDuplicateIndex } from "../lib/near-duplicate-index.ts";

function originalNearDuplicate(value, accepted) {
  const words = new Set(value.split(" ").filter((word) => word.length > 2));
  if (words.size < 3) return true;
  return accepted.some((other) => {
    if (Math.abs(other.length - value.length) > Math.max(12, value.length * 0.3)) return false;
    const otherWords = new Set(other.split(" ").filter((word) => word.length > 2));
    let overlap = 0;
    for (const word of words) if (otherWords.has(word)) overlap++;
    return overlap / Math.max(words.size, otherWords.size) >= 0.82;
  });
}

test("indexed near-duplicate lookup matches the original filter", () => {
  const vocabulary = Array.from({ length: 80 }, (_, index) => `word${index}`);
  const accepted = [];
  const index = new NearDuplicateIndex();
  let state = 0x5eed1234;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };

  const candidates = [
    "one two",
    "alpha beta gamma delta epsilon",
    "alpha beta gamma delta zeta",
    "alpha beta gamma delta epsilon with extra words added",
  ];
  for (let message = 0; message < 1_000; message++) {
    const wordCount = 3 + Math.floor(random() * 15);
    const words = [];
    for (let word = 0; word < wordCount; word++) {
      words.push(vocabulary[Math.floor(random() * vocabulary.length)]);
    }
    candidates.push(words.join(" "));
  }

  for (const candidate of candidates) {
    const expected = originalNearDuplicate(candidate, accepted);
    assert.equal(index.hasNearDuplicate(candidate), expected, candidate);
    if (!expected) {
      accepted.push(candidate);
      index.add(candidate);
    }
  }
});
