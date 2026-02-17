/**
 * Format scored context entries for injection into agent prompt.
 */

import type { ScoredEntry } from "./types.js";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

function sessionLabel(sessionType: string, locale: Locale): string {
  const s = t(locale);
  const map: Record<string, string> = {
    dm: s.sessionDm,
    group: s.sessionGroup,
    cron: s.sessionCron,
    webhook: s.sessionHook,
    isolated: s.sessionTask,
    unknown: s.sessionDefault,
  };
  return map[sessionType] || s.sessionDefault;
}

function formatTimeAgo(timestamp: number, now: number, locale: Locale): string {
  const s = t(locale);
  const diffMs = now - timestamp;
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);

  if (minutes < 1) return s.timeJustNow;
  if (minutes < 60) return s.timeMinutesAgo(minutes);
  if (hours < 24) return s.timeHoursAgo(hours);
  return s.timeDaysAgo(days);
}

/**
 * Rough token estimate: ~4 chars per token for English/German mixed text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatEntryLine(entry: ScoredEntry, now: number, locale: Locale): string {
  const timeAgo = formatTimeAgo(entry.timestamp, now, locale);
  const label = sessionLabel(entry.sessionType, locale);
  return `[${timeAgo} · ${label}] ${entry.summary}`;
}

/**
 * Format context entries into an XML block for prompt injection.
 * Accepts separate chronological (time-ordered) and ranked (score-ordered) lists.
 */
export function formatSlidingContext(
  chronological: ScoredEntry[],
  ranked: ScoredEntry[],
  options: { maxTokens: number; windowHours: number; locale: Locale },
): string {
  const now = Date.now();
  const s = t(options.locale);
  const totalEntries = chronological.length + ranked.length;

  const header = `<sliding-context window="${options.windowHours}h" entries="${totalEntries}">\n${s.contextPreamble}`;

  const footer = `</sliding-context>`;
  let tokenCount = estimateTokens(header) + estimateTokens(footer);

  const sections: string[] = [];

  // Chronological section (today's timeline)
  if (chronological.length > 0) {
    const sectionHeader = `\n\n${s.sectionChronological}`;
    tokenCount += estimateTokens(sectionHeader);
    const lines: string[] = [sectionHeader];

    for (const entry of chronological) {
      const line = `\n${formatEntryLine(entry, now, options.locale)}`;
      const lineTokens = estimateTokens(line);
      if (tokenCount + lineTokens > options.maxTokens) break;
      lines.push(line);
      tokenCount += lineTokens;
    }

    if (lines.length > 1) {
      sections.push(lines.join(""));
    }
  }

  // Ranked section (older relevant context)
  if (ranked.length > 0) {
    const sectionHeader = `\n\n${s.sectionOlderRelevant}`;
    tokenCount += estimateTokens(sectionHeader);
    const lines: string[] = [sectionHeader];

    for (const entry of ranked) {
      const line = `\n${formatEntryLine(entry, now, options.locale)}`;
      const lineTokens = estimateTokens(line);
      if (tokenCount + lineTokens > options.maxTokens) break;
      lines.push(line);
      tokenCount += lineTokens;
    }

    if (lines.length > 1) {
      sections.push(lines.join(""));
    }
  }

  if (sections.length === 0) return "";

  const note = s.tokenFooter(tokenCount, totalEntries);

  return `${header}${sections.join("")}\n${note}\n${footer}`;
}
