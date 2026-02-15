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

  // Recency (0 - 0.3) — exponential decay
  const hoursAgo = (params.now - entry.timestamp) / 3_600_000;
  score += Math.exp(-hoursAgo / 12) * 0.3; // half-life ≈ 8h

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

  // Sort by score descending, take top N
  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored.slice(0, params.maxEntries);
}
