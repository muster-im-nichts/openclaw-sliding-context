/**
 * Rule-based turn summarization — no LLM calls needed.
 * Extracts user intent, tools used, and outcome from messages.
 */

import type { SessionType, MessageRange } from "./types.js";

// ============================================================================
// Message helpers
// ============================================================================

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
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + "…";
}

// ============================================================================
// Trivial turn detection
// ============================================================================

const TRIVIAL_PATTERNS = [
  /^HEARTBEAT_OK$/,
  /^NO_REPLY$/,
  /^HEARTBEAT_OK\s/,
  /^\s*$/,
];

export function isTrivialTurn(messages: unknown[]): boolean {
  if (!messages || messages.length === 0) return true;

  // Check if the last assistant message is trivial
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => (m as MessageLike).role === "assistant");

  if (!lastAssistant) return true;

  const text = textContent(lastAssistant as MessageLike).trim();
  return TRIVIAL_PATTERNS.some((p) => p.test(text));
}

// ============================================================================
// Summarization
// ============================================================================

export function extractTurnSummary(messages: unknown[], maxChars: number): string {
  const msgs = messages as MessageLike[];
  const parts: string[] = [];

  // 1. User intent (first user message)
  const userMsg = msgs.find((m) => m.role === "user");
  if (userMsg) {
    const text = textContent(userMsg);
    if (text) parts.push(truncate(text, Math.floor(maxChars * 0.4)));
  }

  // 2. Tools used
  const toolNames = new Set<string>();
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue;
    const toolCalls = msg.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = (tc as Record<string, unknown>).function as Record<string, unknown> | undefined;
        if (fn?.name) toolNames.add(String(fn.name));
      }
    }
  }
  if (toolNames.size > 0) {
    parts.push(`[${[...toolNames].join(", ")}]`);
  }

  // 3. Outcome (last assistant text)
  const lastAssistant = [...msgs]
    .reverse()
    .find((m) => m.role === "assistant" && textContent(m as MessageLike));
  if (lastAssistant) {
    const text = textContent(lastAssistant);
    if (text && text !== parts[0]) { // avoid duplicating if user=assistant text
      parts.push("→ " + truncate(text, Math.floor(maxChars * 0.4)));
    }
  }

  return parts.join(" ").slice(0, maxChars);
}

// ============================================================================
// Metadata extraction
// ============================================================================

const DECISION_PATTERNS = [
  /\b(decided|decision|we('ll| will)|let's|agreed|going with)\b/i,
  /\b(entschieden|entscheidung|machen wir|lass uns|einig)\b/i,
];

export function hasDecisionSignal(messages: unknown[]): boolean {
  for (const msg of messages as MessageLike[]) {
    const text = textContent(msg);
    if (DECISION_PATTERNS.some((p) => p.test(text))) return true;
  }
  return false;
}

export function hasToolCallsInTurn(messages: unknown[]): boolean {
  return (messages as MessageLike[]).some((m) => {
    if (m.role !== "assistant") return false;
    return Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0;
  });
}

// ============================================================================
// Topic extraction
// ============================================================================

const TOPIC_PATTERNS: Array<{ pattern: RegExp; topic: string }> = [
  { pattern: /\b(PR|pull request)\s*#?\d+/i, topic: "pr-review" },
  { pattern: /\b(deploy|deployment|release|ship)\b/i, topic: "deployment" },
  { pattern: /\b(email|inbox|digest|mail)\b/i, topic: "email" },
  { pattern: /\b(cron|schedule|timer|reminder)\b/i, topic: "scheduling" },
  { pattern: /\b(blog|post|article|draft)\b/i, topic: "blogging" },
  { pattern: /\b(claude.?code|cc-bridge)\b/i, topic: "claude-code" },
  { pattern: /\b(git|commit|branch|merge|rebase)\b/i, topic: "git" },
  { pattern: /\b(test|testing|vitest|jest|spec)\b/i, topic: "testing" },
  { pattern: /\b(refactor|cleanup|reorganize)\b/i, topic: "refactoring" },
  { pattern: /\b(bug|fix|error|crash|broken)\b/i, topic: "bugfix" },
  { pattern: /\b(config|setup|install|bootstrap)\b/i, topic: "setup" },
  { pattern: /\b(security|auth|permission|access)\b/i, topic: "security" },
];

export function extractTopics(messages: unknown[]): string[] {
  const topics = new Set<string>();
  for (const msg of messages as MessageLike[]) {
    const text = textContent(msg);
    for (const { pattern, topic } of TOPIC_PATTERNS) {
      if (pattern.test(text)) topics.add(topic);
    }
  }
  return [...topics];
}

// ============================================================================
// Session type detection
// ============================================================================

export function detectSessionType(sessionKey: string): SessionType {
  if (sessionKey.includes(":group:")) return "group";
  if (sessionKey.startsWith("cron:")) return "cron";
  if (sessionKey.startsWith("hook:")) return "webhook";
  if (sessionKey.includes(":isolated:") || sessionKey.includes("spawn")) return "isolated";
  if (sessionKey.includes(":main")) return "dm";
  return "unknown";
}

// ============================================================================
// Deep Recall: message range & telegram IDs
// ============================================================================

export function extractMessageRange(messages: unknown[]): MessageRange | undefined {
  const msgs = messages as MessageLike[];
  if (msgs.length === 0) return undefined;

  const firstId = msgs[0].id;
  const lastId = msgs[msgs.length - 1].id;

  if (typeof firstId !== "string" || typeof lastId !== "string") return undefined;

  return { startId: firstId, endId: lastId };
}

const TELEGRAM_MSG_ID_PATTERN = /\[message_id:\s*(\d+)\]/g;

export function extractTelegramMessageIds(messages: unknown[]): number[] {
  const ids = new Set<number>();
  for (const msg of messages as MessageLike[]) {
    if (msg.role !== "user") continue;
    const text = textContent(msg);
    for (const match of text.matchAll(TELEGRAM_MSG_ID_PATTERN)) {
      ids.add(Number(match[1]));
    }
  }
  return ids.size > 0 ? [...ids] : [];
}
