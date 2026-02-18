/**
 * Ranking and deduplication for context entries.
 * 
 * Combines semantic relevance, recency, session type, and decision signals
 * into a single score for each entry.
 */

import type { ContextEntry, ContextSearchResult, ScoredEntry } from "./types.js";

export type RankingParams = {
  currentSession: string;
  now: number;
  maxEntries: number;
  decayHalfLifeHours: number;
};

/**
 * Compute a final 0-1 score for a context entry.
 * 
 * Weights:
 *   Semantic relevance:  0.40  (from vector search)
 *   Recency:             0.30  (exponential decay, half-life ~8h)
 *   Same session:        0.10
 *   Decision/tool boost: 0.10
 *   DM boost:            0.10
 */
export function computeScore(
  entry: ContextEntry,
  semanticScore: number,
  params: RankingParams,
): number {
  let score = 0;

  // Semantic relevance (0 - 0.4)
  score += Math.min(semanticScore, 1) * 0.4;

  // Recency (0 - 0.3) — exponential decay with configurable half-life
  const hoursAgo = (params.now - entry.timestamp) / 3_600_000;
  // Formula: exp(-hoursAgo * ln(2) / halfLife) gives exact 50% at halfLife
  const lambda = Math.LN2 / params.decayHalfLifeHours;
  score += Math.exp(-lambda * hoursAgo) * 0.3;

  // Same session boost (0 - 0.1)
  if (entry.sessionKey === params.currentSession) {
    score += 0.1;
  }

  // Decision or tool-call boost (0 - 0.1)
  if (entry.hasDecision || entry.hasToolCalls) {
    score += 0.1;
  }

  // DM boost over cron/webhook (0 - 0.1)
  if (entry.sessionType === "dm") {
    score += 0.1;
  }

  return score;
}

/**
 * Merge recent entries (time-based) with relevant entries (semantic),
 * deduplicate, rank, and return top N.
 */
export function deduplicateAndRank(
  recent: ContextEntry[],
  relevant: ContextSearchResult[],
  params: RankingParams,
): ScoredEntry[] {
  const seen = new Set<string>();
  const scored: ScoredEntry[] = [];

  // Score recent entries (no semantic score → use 0)
  for (const entry of recent) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    scored.push({
      ...entry,
      finalScore: computeScore(entry, 0, params),
    });
  }

  // Score relevant entries (with semantic score)
  for (const { entry, score: semanticScore } of relevant) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    scored.push({
      ...entry,
      finalScore: computeScore(entry, semanticScore, params),
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Content-similarity dedup: if two entries are within 60min and share
  // >60% of their significant words, keep only the higher-scored one.
  const deduped = contentDedup(scored);

  return deduped.slice(0, params.maxEntries);
}

/**
 * Extract significant words (>3 chars) from a summary, lowercased.
 */
function significantWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-zäöüß0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

/**
 * Jaccard similarity between two word sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Remove entries that are too similar to a higher-scored entry within a time window.
 * This prevents the same topic (e.g., "blog fix") from consuming multiple slots.
 */
function contentDedup(entries: ScoredEntry[], windowMs = 3_600_000, threshold = 0.55): ScoredEntry[] {
  const result: ScoredEntry[] = [];
  const wordCache: Array<Set<string>> = [];

  for (const entry of entries) {
    const words = significantWords(entry.summary);
    let isDuplicate = false;

    for (let i = 0; i < result.length; i++) {
      const existing = result[i];
      // Only dedup within time window
      if (Math.abs(entry.timestamp - existing.timestamp) > windowMs) continue;
      if (jaccardSimilarity(words, wordCache[i]) >= threshold) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      result.push(entry);
      wordCache.push(words);
    }
  }

  return result;
}

/**
 * Split entries into chronological (recent window, time-ordered) and
 * ranked (older, score-ordered) groups.
 *
 * Chronological entries are sorted oldest→newest (ASC) to form a timeline.
 * Ranked entries are sorted by finalScore descending.
 */
export function splitChronologicalAndRanked(
  entries: ScoredEntry[],
  recentWindowHours: number,
  now: number,
): { chronological: ScoredEntry[]; ranked: ScoredEntry[] } {
  const cutoff = now - recentWindowHours * 3_600_000;

  const chronological: ScoredEntry[] = [];
  const ranked: ScoredEntry[] = [];

  for (const entry of entries) {
    if (entry.timestamp >= cutoff) {
      chronological.push(entry);
    } else {
      ranked.push(entry);
    }
  }

  // Chronological: oldest first (timeline order)
  chronological.sort((a, b) => a.timestamp - b.timestamp);
  // Ranked: best score first
  ranked.sort((a, b) => b.finalScore - a.finalScore);

  return { chronological, ranked };
}
