/**
 * LLM-based turn summarization using Claude Sonnet.
 * Produces higher quality summaries than rule-based extraction.
 * Falls back to rule-based if LLM call fails.
 *
 * Supports smart deduplication: when recent entries are provided,
 * the LLM classifies the response as NEW, UPDATE, or SKIP.
 */

import { extractTurnSummary } from "./summarize.js";
import type { Locale } from "./i18n.js";
import { t } from "./i18n.js";
import type { ContextEntry } from "./types.js";

type MessageLike = Record<string, unknown>;

function textContent(msg: MessageLike): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is Record<string, unknown> =>
          b &&
          typeof b === "object" &&
          (b as Record<string, unknown>).type === "text",
      )
      .map((b) => String((b as Record<string, unknown>).text ?? ""))
      .join(" ");
  }
  return "";
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/**
 * Extract only the LAST interaction (user message → assistant response) from the session.
 * This avoids summarizing the entire session repeatedly — each turn captures only
 * what's new, building a granular history entry by entry.
 */
export function buildTranscript(messages: unknown[], maxChars: number): string {
  const msgs = messages as MessageLike[];
  const lines: string[] = [];

  // Find the last user message (the trigger for this turn)
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) return "";

  // Collect from last user message to end (= this turn only)
  const turnMessages = msgs.slice(lastUserIdx);
  let charCount = 0;

  for (const msg of turnMessages) {
    const role = msg.role as string;
    if (!role || role === "system") continue;

    if (role === "tool") {
      const name = msg.name ?? "tool";
      const line = `[Tool result: ${name}]`;
      if (charCount + line.length > maxChars) break;
      lines.push(line);
      charCount += line.length;
      continue;
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      const calls = (msg.tool_calls as Record<string, unknown>[]).map((tc) => {
        const fn = tc.function as Record<string, unknown> | undefined;
        return fn?.name ?? "unknown";
      });
      const line = `[Assistant called: ${calls.join(", ")}]`;
      if (charCount + line.length > maxChars) break;
      lines.push(line);
      charCount += line.length;
      continue;
    }

    const text = textContent(msg);
    if (!text) continue;

    const prefix = role === "user" ? "User" : "Assistant";
    const truncated = truncate(text, Math.min(400, maxChars - charCount));
    const line = `${prefix}: ${truncated}`;
    if (charCount + line.length > maxChars) break;
    lines.push(line);
    charCount += line.length;
  }

  return lines.join("\n");
}

export type LlmSummarizeConfig = {
  apiKey: string;
  model: string;
  maxChars: number;
  locale: Locale;
};

export type SummarizeAction = "new" | "update" | "skip";

export type SummarizeResult = {
  action: SummarizeAction;
  summary: string;
  replaceId?: string;
};

/**
 * Parse the LLM response to extract the dedup classification.
 * Expected formats: "NEW: ...", "UPDATE [N]: ...", "SKIP"
 * Falls back to action "new" if parsing fails.
 */
export function parseDedupResponse(
  text: string,
  recentEntries: ContextEntry[],
): SummarizeResult {
  const trimmed = text.trim();

  // Check for SKIP
  if (/^SKIP\s*$/i.test(trimmed)) {
    return { action: "skip", summary: "" };
  }

  // Check for UPDATE [N]: ...
  const updateMatch = trimmed.match(/^UPDATE\s*\[(\d+)]\s*:\s*(.+)/is);
  if (updateMatch) {
    const idx = parseInt(updateMatch[1], 10) - 1; // Convert 1-based to 0-based
    const summary = updateMatch[2].trim();
    if (idx >= 0 && idx < recentEntries.length && summary.length >= 10) {
      return {
        action: "update",
        summary,
        replaceId: recentEntries[idx].id,
      };
    }
    // Invalid index or summary too short → treat as NEW
    return { action: "new", summary: summary || trimmed };
  }

  // Check for NEW: ...
  const newMatch = trimmed.match(/^NEW\s*:\s*(.+)/is);
  if (newMatch) {
    return { action: "new", summary: newMatch[1].trim() };
  }

  // No prefix recognized → safe default: treat as NEW with the full text
  return { action: "new", summary: trimmed };
}

/**
 * Summarize a turn using an LLM (Claude Sonnet) with smart deduplication.
 * When recentEntries are provided, the LLM classifies the result as NEW/UPDATE/SKIP.
 * Falls back to rule-based extraction on failure.
 */
export async function summarizeWithLlm(
  messages: unknown[],
  config: LlmSummarizeConfig,
  logger?: { warn: (msg: string) => void },
  recentEntries?: ContextEntry[],
): Promise<SummarizeResult> {
  const transcript = buildTranscript(messages, 3000);
  if (!transcript || transcript.length < 20) {
    return {
      action: "new",
      summary: extractTurnSummary(messages, config.maxChars),
    };
  }

  // Filter out sliding-context injections from being summarized
  if (transcript.includes("<sliding-context window=")) {
    // Strip the injected context block from the transcript
    const cleaned = transcript.replace(/<sliding-context[\s\S]*?<\/sliding-context>/g, "").trim();
    if (!cleaned || cleaned.length < 20) {
      return { action: "skip", summary: "" };
    }
  }

  const strings = t(config.locale);

  // Build the dedup suffix if we have recent entries
  const dedupSuffix =
    recentEntries && recentEntries.length > 0
      ? strings.dedupPrompt(recentEntries.map((e) => e.summary))
      : "";

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `${strings.summarizationPrompt}${dedupSuffix}

<transcript>
${transcript}
</transcript>

Summary:`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic API ${response.status}: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content?.[0]?.text?.trim();
    if (!text || text.length < 3) {
      return {
        action: "new",
        summary: extractTurnSummary(messages, config.maxChars),
      };
    }

    // If we had recent entries, parse the dedup classification
    if (recentEntries && recentEntries.length > 0) {
      const result = parseDedupResponse(text, recentEntries);
      if (result.action === "skip") return result;
      return result;
    }

    // No dedup context → treat as plain summary
    return { action: "new", summary: text };
  } catch (err) {
    logger?.warn(
      `sliding-context: LLM summarization failed, using rule-based: ${String(err)}`,
    );
    return {
      action: "new",
      summary: extractTurnSummary(messages, config.maxChars),
    };
  }
}
