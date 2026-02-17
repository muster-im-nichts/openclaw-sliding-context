/**
 * LLM-based turn summarization using Claude Sonnet.
 * Produces higher quality summaries than rule-based extraction.
 * Falls back to rule-based if LLM call fails.
 */

import { extractTurnSummary } from "./summarize.js";

type MessageLike = Record<string, unknown>;

function textContent(msg: MessageLike): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is Record<string, unknown> =>
        b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
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
function buildTranscript(messages: unknown[], maxChars: number): string {
  const msgs = messages as MessageLike[];
  const lines: string[] = [];

  // Find the last user message (the trigger for this turn)
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if ((msgs[i]).role === "user") {
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
      const calls = (msg.tool_calls as Record<string, unknown>[])
        .map((tc) => {
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
};

/**
 * Summarize a turn using an LLM (Claude Sonnet).
 * Falls back to rule-based extraction on failure.
 */
export async function summarizeWithLlm(
  messages: unknown[],
  config: LlmSummarizeConfig,
  logger?: { warn: (msg: string) => void },
): Promise<string> {
  const transcript = buildTranscript(messages, 2500);
  if (!transcript || transcript.length < 20) {
    return extractTurnSummary(messages, config.maxChars);
  }

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
        max_tokens: 250,
        messages: [
          {
            role: "user",
            content: `Summarize this agent conversation turn in 1-3 sentences. Focus on:
1. What was the user's request or question?
2. What concrete actions were taken? (files changed, commands run, decisions made)
3. What was the outcome or result?

Be specific about filenames, numbers, and decisions. Use the same language as the conversation (German if German, English if English).

<transcript>
${transcript}
</transcript>

Summary:`,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content?.[0]?.text?.trim();
    if (text && text.length >= 10) {
      return truncate(text, config.maxChars);
    }

    // Fallback if response is too short
    return extractTurnSummary(messages, config.maxChars);
  } catch (err) {
    logger?.warn(`sliding-context: LLM summarization failed, using rule-based: ${String(err)}`);
    return extractTurnSummary(messages, config.maxChars);
  }
}
