#!/usr/bin/env npx tsx
/**
 * Cleanup script for sliding context — consolidates duplicate entries.
 *
 * Usage:
 *   npx tsx scripts/cleanup.ts --db-path /path/to/lancedb [--dry-run] [--similarity 0.85]
 *
 * Groups similar entries by embedding cosine similarity, then uses an LLM
 * to merge each group into a single consolidated entry.
 */

import { cpSync, existsSync } from "node:fs";
import { ContextStore } from "../src/store.js";
import { vectorDimsForModel } from "../src/config.js";
import { t, type Locale } from "../src/i18n.js";
import type { ContextEntry } from "../src/types.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

type CliArgs = {
  dbPath: string;
  dryRun: boolean;
  backupDir: string;
  similarity: number;
  apiKey: string;
  embeddingModel: string;
  locale: Locale;
};

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  let dbPath = "";
  let dryRun = false;
  let backupDir = "";
  let similarity = 0.85;
  let apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  let embeddingModel = "text-embedding-3-small";
  let locale: Locale = "de";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--db-path":
        dbPath = args[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--backup-dir":
        backupDir = args[++i];
        break;
      case "--similarity":
        similarity = parseFloat(args[++i]);
        break;
      case "--api-key":
        apiKey = args[++i];
        break;
      case "--embedding-model":
        embeddingModel = args[++i];
        break;
      case "--locale":
        locale = args[++i] === "en" ? "en" : "de";
        break;
    }
  }

  if (!dbPath) {
    console.error("Error: --db-path is required");
    console.error(
      "Usage: npx tsx scripts/cleanup.ts --db-path /path/to/lancedb [--dry-run] [--similarity 0.85]",
    );
    process.exit(1);
  }

  if (!apiKey) {
    console.error(
      "Error: --api-key or ANTHROPIC_API_KEY environment variable is required",
    );
    process.exit(1);
  }

  if (!backupDir) {
    backupDir = `${dbPath}.backup.${Date.now()}`;
  }

  return {
    dbPath,
    dryRun,
    backupDir,
    similarity,
    apiKey,
    embeddingModel,
    locale,
  };
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Group similar entries by embedding similarity
// ---------------------------------------------------------------------------

export function groupSimilar(
  entries: ContextEntry[],
  threshold: number,
): ContextEntry[][] {
  const used = new Set<string>();
  const groups: ContextEntry[][] = [];

  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    if (used.has(a.id)) continue;

    const group: ContextEntry[] = [a];
    used.add(a.id);

    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (used.has(b.id)) continue;

      const sim = cosineSimilarity(a.vector, b.vector);
      if (sim >= threshold) {
        group.push(b);
        used.add(b.id);
      }
    }

    // Only include groups with more than 1 entry (actual duplicates)
    if (group.length > 1) {
      groups.push(group);
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// LLM merge via Anthropic API
// ---------------------------------------------------------------------------

async function mergeWithLlm(
  entries: ContextEntry[],
  apiKey: string,
  locale: Locale,
): Promise<string> {
  const strings = t(locale);
  const entriesText = entries
    .map((e, i) => `[${i + 1}] ${e.summary}`)
    .join("\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `${strings.cleanupMergePrompt}

${entriesText}`,
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
  if (!text || text.length < 10) {
    // Fallback: keep the most recent entry's summary
    return entries.sort((a, b) => b.timestamp - a.timestamp)[0].summary;
  }

  return text;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function backupDatabase(dbPath: string, backupDir: string): void {
  if (!existsSync(dbPath)) {
    throw new Error(`Database path does not exist: ${dbPath}`);
  }
  console.log(`Backing up database to: ${backupDir}`);
  cpSync(dbPath, backupDir, { recursive: true });
  console.log("Backup complete.");
}

// ---------------------------------------------------------------------------
// Main cleanup logic (exported for testability)
// ---------------------------------------------------------------------------

export async function runCleanup(args: CliArgs): Promise<void> {
  const vectorDim = vectorDimsForModel(args.embeddingModel);

  // Step 1: Backup
  if (!args.dryRun) {
    backupDatabase(args.dbPath, args.backupDir);
  } else {
    console.log("[DRY RUN] Skipping backup.");
  }

  // Step 2: Load all entries
  const store = new ContextStore(args.dbPath, vectorDim);
  const entries = await store.getAll();
  console.log(`Loaded ${entries.length} entries.`);

  if (entries.length < 2) {
    console.log("Not enough entries to deduplicate.");
    return;
  }

  // Step 3: Group similar entries
  const groups = groupSimilar(entries, args.similarity);
  console.log(`Found ${groups.length} group(s) of similar entries to merge.`);

  if (groups.length === 0) {
    console.log("No duplicates found. Database is clean.");
    return;
  }

  let totalRemoved = 0;

  // Step 4: Merge each group
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const summaries = group.map((e) => `  "${e.summary}"`).join("\n");
    console.log(`\nGroup ${gi + 1} (${group.length} entries):\n${summaries}`);

    if (args.dryRun) {
      console.log(`  [DRY RUN] Would merge ${group.length} entries.`);
      totalRemoved += group.length - 1;
      continue;
    }

    // Use LLM to merge
    const mergedSummary = await mergeWithLlm(group, args.apiKey, args.locale);
    console.log(`  Merged: "${mergedSummary}"`);

    // Keep the most recent entry's metadata, update its summary
    const newest = group.sort((a, b) => b.timestamp - a.timestamp)[0];

    // Delete all entries in the group
    for (const entry of group) {
      await store.deleteById(entry.id);
    }

    // Re-embed the merged summary using OpenAI
    const { Embeddings } = await import("../src/embeddings.js");
    const embeddingApiKey = process.env.OPENAI_API_KEY ?? args.apiKey;
    const emb = new Embeddings(embeddingApiKey, args.embeddingModel);
    const vector = await emb.embed(mergedSummary);

    // Store the merged entry
    await store.store({
      summary: mergedSummary,
      vector,
      sessionKey: newest.sessionKey,
      sessionType: newest.sessionType,
      channel: newest.channel,
      timestamp: newest.timestamp,
      hasToolCalls: group.some((e) => e.hasToolCalls),
      hasDecision: group.some((e) => e.hasDecision),
      topics: [...new Set(group.flatMap((e) => e.topics))],
      sessionFile: newest.sessionFile,
      messageRange: newest.messageRange,
      telegramMessageIds: newest.telegramMessageIds,
    });

    totalRemoved += group.length - 1;
  }

  // Step 5: Report
  const totalAfter = entries.length - totalRemoved;
  console.log(
    `\nDone. Merged ${groups.length} group(s), reduced ${entries.length} entries to ${totalAfter} entries (removed ${totalRemoved}).`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv);
runCleanup(args).catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
