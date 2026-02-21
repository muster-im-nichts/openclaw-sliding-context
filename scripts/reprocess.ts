#!/usr/bin/env tsx
/**
 * Reprocess historical session transcripts through the new summarization prompt.
 * Reads JSONL session files and re-summarizes them, replacing old entries in the DB.
 *
 * Usage:
 *   npx tsx scripts/reprocess.ts --db-path /path/to/lancedb --sessions-dir /path/to/sessions [--days 7] [--dry-run]
 *
 * Requires: ANTHROPIC_API_KEY and OPENAI_API_KEY env vars
 */

import * as fs from "fs";
import * as path from "path";
import { ContextStore } from "../src/store.js";
import { vectorDimsForModel } from "../src/config.js";
import { summarizeWithLlm, type LlmSummarizeConfig } from "../src/summarize-llm.js";
import type { Locale } from "../src/i18n.js";

// --- Embedding helper (same as in cleanup.ts) ---
async function embed(text: string, apiKey: string, model: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: text, model }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

// --- Parse CLI args ---
function parseArgs() {
  const args = process.argv.slice(2);
  let dbPath = "";
  let sessionsDir = "";
  let days = 7;
  let dryRun = false;
  let locale: Locale = "de";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db-path" && args[i + 1]) dbPath = args[++i];
    else if (args[i] === "--sessions-dir" && args[i + 1]) sessionsDir = args[++i];
    else if (args[i] === "--days" && args[i + 1]) days = parseInt(args[++i], 10);
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--locale" && args[i + 1]) locale = args[++i] as Locale;
  }

  if (!dbPath || !sessionsDir) {
    console.error("Usage: npx tsx scripts/reprocess.ts --db-path <path> --sessions-dir <path> [--days 7] [--dry-run] [--locale de]");
    process.exit(1);
  }

  return { dbPath, sessionsDir, days, dryRun, locale };
}

// --- Read and parse JSONL session file ---
type SessionMessage = { role: string; content: unknown; tool_calls?: unknown[]; name?: string };

function readSession(filePath: string): SessionMessage[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const messages: SessionMessage[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.role) messages.push(parsed);
    } catch {
      // Skip unparseable lines
    }
  }

  return messages;
}

// --- Extract turns from a session ---
type Turn = { messages: SessionMessage[]; timestamp: number };

function extractTurns(messages: SessionMessage[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurnStart = -1;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      // If we had a previous turn, close it
      if (currentTurnStart >= 0) {
        turns.push({
          messages: messages.slice(currentTurnStart, i),
          timestamp: Date.now(), // Will be overridden below
        });
      }
      currentTurnStart = i;
    }
  }

  // Last turn
  if (currentTurnStart >= 0) {
    turns.push({
      messages: messages.slice(currentTurnStart),
      timestamp: Date.now(),
    });
  }

  return turns;
}

// --- Main ---
async function main() {
  const { dbPath, sessionsDir, days, dryRun, locale } = parseArgs();

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey || !openaiKey) {
    console.error("ANTHROPIC_API_KEY and OPENAI_API_KEY env vars required");
    process.exit(1);
  }

  const llmConfig: LlmSummarizeConfig = {
    apiKey: anthropicKey,
    model: "claude-sonnet-4-20250514",
    maxChars: 2000, // Generous — prompt handles length naturally
    locale,
  };

  const embeddingModel = "text-embedding-3-small";

  // Find session files from last N days
  const cutoff = Date.now() - days * 24 * 3600_000;
  const files = fs.readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      name: f,
      path: path.join(sessionsDir, f),
      mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
    }))
    .filter((f) => f.mtime >= cutoff)
    .sort((a, b) => a.mtime - b.mtime);

  console.log(`Found ${files.length} session files from last ${days} days.`);
  if (dryRun) console.log("[DRY RUN] Will not write to DB.\n");

  const store = new ContextStore(dbPath, vectorDimsForModel(embeddingModel));
  let processed = 0;
  let skipped = 0;
  let created = 0;

  for (const file of files) {
    const messages = readSession(file.path);
    if (messages.length < 2) continue; // Skip trivial sessions

    const turns = extractTurns(messages);
    if (turns.length === 0) continue;

    // Summarize the last turn (most representative of the session)
    const lastTurn = turns[turns.length - 1];

    const result = await summarizeWithLlm(
      lastTurn.messages,
      llmConfig,
      { warn: (msg) => console.warn(msg) },
    );

    processed++;

    if (result.action === "skip" || !result.summary || result.summary.length < 10) {
      skipped++;
      console.log(`SKIP: ${file.name} (routine/trivial)`);
      continue;
    }

    const summary = result.summary;
    const sessionId = file.name.replace(".jsonl", "");

    if (dryRun) {
      console.log(`NEW: ${file.name}`);
      console.log(`  → ${summary.slice(0, 200)}${summary.length > 200 ? "..." : ""}`);
      console.log();
    } else {
      // Create embedding and store
      const vector = await embed(summary, openaiKey, embeddingModel);
      await store.upsert({
        id: `reprocess-${sessionId}`,
        summary,
        vector,
        timestamp: file.mtime,
        sessionType: "reprocessed",
        sessionFile: file.path,
      });
      created++;
      console.log(`✅ ${file.name}: ${summary.slice(0, 120)}...`);
    }

    // Rate limit: ~0.5s between API calls
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone. Processed: ${processed}, Created: ${created}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error("Reprocess failed:", err);
  process.exit(1);
});
