/**
 * Timeline context block — long-term temporal awareness.
 *
 * Generates a compact timeline from workspace files (IDENTITY.md, MEMORY.md,
 * memory/*.md). Runs on every before_agent_start; purely filesystem reads,
 * no API calls.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";

function formatDate(date: Date, locale: Locale): string {
  const s = t(locale);
  return `${date.getDate()}. ${s.months[date.getMonth()]} ${date.getFullYear()}`;
}

function daysAgo(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

function dayOfWeek(date: Date, locale: Locale): string {
  return t(locale).days[date.getDay()];
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Try to extract a birth/creation date from text.
 * Looks for patterns like "born: 2025-02-05", "geboren: ...", "active since: ..."
 */
function extractBirthDate(text: string): Date | null {
  const patterns = [
    /(?:born|geboren|active since|created|started)[:\s]+(\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
    /(?:born|geboren|active since|created|started)[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const parsed = new Date(match[1]);
      if (!isNaN(parsed.getTime())) return parsed;
    }
  }
  return null;
}

/**
 * Extract a short weekly summary from a file's content (first ~80 chars of content).
 */
function extractWeekSummary(content: string, maxLen = 80): string {
  const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const text = lines.slice(0, 5).join(", ").replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/**
 * Scan memory directory for date-based files (YYYY-MM-DD.md).
 * Returns sorted list of dates found.
 */
async function scanMemoryDates(memoryDir: string): Promise<Date[]> {
  let files: string[];
  try {
    files = await readdir(memoryDir);
  } catch {
    return [];
  }

  const datePattern = /^(\d{4}-\d{2}-\d{2})\.md$/;
  const dates: Date[] = [];

  for (const file of files) {
    const match = file.match(datePattern);
    if (match) {
      const d = new Date(match[1]);
      if (!isNaN(d.getTime())) dates.push(d);
    }
  }

  dates.sort((a, b) => a.getTime() - b.getTime());
  return dates;
}

/**
 * Try to get the workspace creation date from filesystem metadata.
 */
async function getWorkspaceCreationDate(workspacePath: string): Promise<Date | null> {
  try {
    const s = await stat(workspacePath);
    return s.birthtime;
  } catch {
    return null;
  }
}

/**
 * Determine which week (this week vs last week) a date falls into.
 */
function weekBucket(date: Date, now: Date): "this" | "last" | "older" {
  const d = daysAgo(date, now);
  if (d < 7) return "this";
  if (d < 14) return "last";
  return "older";
}

/**
 * Generate a compact timeline block (~100-150 tokens) from workspace files.
 */
export async function generateTimeline(workspacePath: string, locale: Locale): Promise<string> {
  const now = new Date();
  const s = t(locale);
  const lines: string[] = [];

  // 1. Try to find birth date from IDENTITY.md or MEMORY.md
  let birthDate: Date | null = null;

  const identityContent = await readFileSafe(join(workspacePath, "IDENTITY.md"));
  if (identityContent) {
    birthDate = extractBirthDate(identityContent);
  }

  if (!birthDate) {
    const memoryContent = await readFileSafe(join(workspacePath, "MEMORY.md"));
    if (memoryContent) {
      birthDate = extractBirthDate(memoryContent);
    }
  }

  // Fallback: workspace directory creation date
  if (!birthDate) {
    birthDate = await getWorkspaceCreationDate(workspacePath);
  }

  if (birthDate) {
    const d = daysAgo(birthDate, now);
    lines.push(s.timelineActiveSince(formatDate(birthDate, locale), d));
  }

  // 2. Scan memory directory for daily entries
  const memoryDir = join(workspacePath, "memory");
  const memoryDates = await scanMemoryDates(memoryDir);

  if (memoryDates.length > 0) {
    const first = memoryDates[0];
    const last = memoryDates[memoryDates.length - 1];
    lines.push(
      s.timelineMemoryFiles(
        memoryDates.length,
        formatDate(first, locale),
        formatDate(last, locale),
      ),
    );

    // Categorize memory dates into this week / last week
    const thisWeekDates = memoryDates.filter((d) => weekBucket(d, now) === "this");
    const lastWeekDates = memoryDates.filter((d) => weekBucket(d, now) === "last");

    // Read latest memory files for weekly summaries
    if (thisWeekDates.length > 0) {
      const latestThisWeek = thisWeekDates[thisWeekDates.length - 1];
      const fileName = latestThisWeek.toISOString().slice(0, 10) + ".md";
      const content = await readFileSafe(join(memoryDir, fileName));
      if (content) {
        const summary = extractWeekSummary(content);
        if (summary) {
          lines.push(`${s.timelineThisWeek(formatDate(now, locale))}: ${summary}`);
        }
      }
    }

    if (lastWeekDates.length > 0) {
      const latestLastWeek = lastWeekDates[lastWeekDates.length - 1];
      const fileName = latestLastWeek.toISOString().slice(0, 10) + ".md";
      const content = await readFileSafe(join(memoryDir, fileName));
      if (content) {
        const summary = extractWeekSummary(content);
        if (summary) {
          const weekStart = lastWeekDates[0];
          const weekEnd = lastWeekDates[lastWeekDates.length - 1];
          lines.push(
            `${s.timelineLastWeek(formatDate(weekStart, locale), formatDate(weekEnd, locale))}: ${summary}`,
          );
        }
      }
    }
  }

  // 3. Current date/time
  lines.push(s.timelineCurrentDate(dayOfWeek(now, locale), formatDate(now, locale)));

  if (lines.length <= 1) {
    // Only current date — not enough to justify a timeline block
    return "";
  }

  return `<timeline>\n${lines.join("\n")}\n</timeline>`;
}
