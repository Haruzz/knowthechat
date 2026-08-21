type Fingerprint = {
  textLength: number;
  words: Set<string>;
};

const OVERLAP_RATIO = 0.82;

function significantWords(value: string) {
  return new Set(value.split(" ").filter((word) => word.length > 2));
}

/**
 * Finds near-duplicate normalized messages without comparing every message to
 * every previously accepted message. The final length and overlap checks are
 * intentionally identical to the original filter.
 */
export class NearDuplicateIndex {
  private readonly accepted: Fingerprint[] = [];
  private readonly postings = new Map<string, number[]>();

  hasNearDuplicate(value: string) {
    const words = significantWords(value);
    if (words.size < 3) return true;

    // A matching message must contain at least this many candidate words. By
    // probing one more word than a match is allowed to omit, every real match
    // is guaranteed to occur in at least one selected posting list.
    const minimumCandidateOverlap = Math.ceil(OVERLAP_RATIO * words.size);
    const probeCount = words.size - minimumCandidateOverlap + 1;
    const probes = [...words]
      .map((word) => ({ word, matches: this.postings.get(word) ?? [] }))
      .sort((a, b) => a.matches.length - b.matches.length)
      .slice(0, probeCount);

    const candidates = new Set<number>();
    for (const probe of probes) {
      for (const index of probe.matches) candidates.add(index);
    }

    for (const index of candidates) {
      const other = this.accepted[index];
      if (Math.abs(other.textLength - value.length) > Math.max(12, value.length * 0.3)) continue;

      let overlap = 0;
      for (const word of words) if (other.words.has(word)) overlap++;
      if (overlap / Math.max(words.size, other.words.size) >= OVERLAP_RATIO) return true;
    }

    return false;
  }

  add(value: string) {
    const words = significantWords(value);
    const index = this.accepted.length;
    this.accepted.push({ textLength: value.length, words });
    for (const word of words) {
      const matches = this.postings.get(word);
      if (matches) matches.push(index);
      else this.postings.set(word, [index]);
    }
  }
}
