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
 * Build a compact transcript from the MOST RECENT messages for the LLM to summarize.
 * Reads from the end of the conversation backwards to capture the latest turn.
 * Strips tool call details and keeps it focused.
 */
function buildTranscript(messages: unknown[], maxChars: number): string {
  const lines: string[] = [];
  let charCount = 0;

  // Walk backwards from the most recent messages
  const msgs = (messages as MessageLike[]).slice().reverse();

  for (const msg of msgs) {
    const role = msg.role as string;
    if (!role) continue;

    // Skip system messages
    if (role === "system") continue;

    // For tool results, just note the tool name
    if (role === "tool") {
      const name = msg.name ?? "tool";
      const line = `[Tool result: ${name}]`;
      if (charCount + line.length > maxChars) break;
      lines.unshift(line); // prepend to keep chronological order
      charCount += line.length;
      continue;
    }

    // For assistant tool calls, list what was called
    if (role === "assistant" && Array.isArray(msg.tool_calls)) {
      const calls = (msg.tool_calls as Record<string, unknown>[])
        .map((tc) => {
          const fn = tc.function as Record<string, unknown> | undefined;
          return fn?.name ?? "unknown";
        });
      const line = `[Assistant called: ${calls.join(", ")}]`;
      if (charCount + line.length > maxChars) break;
      lines.unshift(line);
      charCount += line.length;
      continue;
    }

    const text = textContent(msg);
    if (!text) continue;

    const prefix = role === "user" ? "User" : "Assistant";
    const truncated = truncate(text, Math.min(300, maxChars - charCount));
    const line = `${prefix}: ${truncated}`;
    if (charCount + line.length > maxChars) break;
    lines.unshift(line);
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
  const transcript = buildTranscript(messages, 1500);
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
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: `Summarize this agent conversation turn in 1-2 sentences. Focus on: what was requested, what was done, and the outcome. Be concise and factual. Use the same language as the conversation (German if German, English if English).

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
