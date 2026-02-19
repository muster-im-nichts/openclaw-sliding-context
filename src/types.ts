/**
 * Core types for the sliding context plugin.
 */

export type SessionType = "dm" | "group" | "cron" | "webhook" | "isolated" | "unknown";

export type MessageRange = {
  startId: string;
  endId: string;
};

export type ContextEntry = {
  id: string;
  summary: string;
  vector: number[];
  sessionKey: string;
  sessionType: SessionType;
  channel: string;
  timestamp: number;
  hasToolCalls: boolean;
  hasDecision: boolean;
  topics: string[];
  sessionFile?: string;
  messageRange?: MessageRange;
  telegramMessageIds?: number[];
};

export type ContextSearchResult = {
  entry: ContextEntry;
  score: number;
};

export type ScoredEntry = ContextEntry & {
  finalScore: number;
};
