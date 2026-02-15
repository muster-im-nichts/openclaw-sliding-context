/**
 * OpenClaw Sliding Context Plugin
 *
 * Cross-session working memory. Automatically captures turn summaries
 * from all sessions and injects relevant recent context before every
 * agent turn — so every trigger (DM, cron, webhook, group) knows
 * what just happened.
 *
 * @author muster-im-nichts (Echo + Nico)
 * @license MIT
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { parseConfig, vectorDimsForModel } from "./config.js";
import { Embeddings } from "./embeddings.js";
import { ContextStore } from "./store.js";
import {
  isTrivialTurn,
  extractTurnSummary,
  hasDecisionSignal,
  hasToolCallsInTurn,
  extractTopics,
  detectSessionType,
} from "./summarize.js";
import { summarizeWithLlm } from "./summarize-llm.js";
import { deduplicateAndRank } from "./ranking.js";
import { formatSlidingContext } from "./format.js";

const slidingContextPlugin = {
  id: "sliding-context",
  name: "Sliding Context",
  description: "Cross-session working memory with sliding context window",

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath);
    const vectorDim = vectorDimsForModel(cfg.embedding.model);
    const store = new ContextStore(resolvedDbPath, vectorDim);
    const embeddings = new Embeddings(cfg.embedding.apiKey, cfg.embedding.model);

    api.logger.info(`sliding-context: registered (db: ${resolvedDbPath}, window: ${cfg.windowHours}h)`);

    // ========================================================================
    // Capture: index turn summaries after every agent turn
    // ========================================================================

    api.on("agent_end", async (event) => {
      const messages = event.messages as unknown[] | undefined;
      if (!messages || messages.length === 0) return;

      // Skip trivial turns (HEARTBEAT_OK, NO_REPLY)
      if (cfg.skipTrivial && isTrivialTurn(messages)) return;

      // Skip excluded sessions
      const sessionKey = (event as Record<string, unknown>).sessionKey as string | undefined ?? "unknown";
      if (cfg.skipSessions.includes(sessionKey)) return;

      try {
        // Extract summary (LLM or rule-based)
        let summary: string;
        if (cfg.summarization.mode === "llm") {
          const llmApiKey = cfg.summarization.apiKey ?? cfg.embedding.apiKey;
          summary = await summarizeWithLlm(messages, {
            apiKey: llmApiKey,
            model: cfg.summarization.model,
            maxChars: cfg.summaryMaxChars,
          }, api.logger);
        } else {
          summary = extractTurnSummary(messages, cfg.summaryMaxChars);
        }
        if (!summary || summary.length < 10) return;

        // Embed
        const vector = await embeddings.embed(summary);

        // Store
        await store.store({
          summary,
          vector,
          sessionKey,
          sessionType: detectSessionType(sessionKey),
          channel: (event as Record<string, unknown>).channel as string ?? "",
          timestamp: Date.now(),
          hasToolCalls: hasToolCallsInTurn(messages),
          hasDecision: hasDecisionSignal(messages),
          topics: extractTopics(messages),
        });

        // Prune expired entries
        await store.pruneOlderThan(cfg.windowHours);

        api.logger.debug?.(`sliding-context: captured turn from ${sessionKey} (${summary.length} chars)`);
      } catch (err) {
        api.logger.warn(`sliding-context: capture failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Recall: inject relevant context before every agent turn
    // ========================================================================

    api.on("before_agent_start", async (event) => {
      const prompt = event.prompt;
      if (!prompt || prompt.length < 5) return;

      const sessionKey = (event as Record<string, unknown>).sessionKey as string | undefined ?? "unknown";

      try {
        // Two-pass retrieval
        const [recent, vector] = await Promise.all([
          store.getRecent(cfg.recentCount, cfg.windowHours),
          embeddings.embed(prompt),
        ]);

        const relevant = await store.search(vector, cfg.relevantCount, 0.3);

        // Merge, rank, deduplicate
        const merged = deduplicateAndRank(recent, relevant, {
          currentSession: sessionKey,
          now: Date.now(),
          maxEntries: cfg.maxInjectEntries,
          decayHalfLifeHours: cfg.decayHalfLifeHours,
        });

        if (merged.length === 0) return;

        // Format for injection
        const context = formatSlidingContext(merged, {
          maxTokens: cfg.maxInjectTokens,
          windowHours: cfg.windowHours,
        });

        if (!context) return;

        api.logger.info?.(`sliding-context: injecting ${merged.length} entries into ${sessionKey}`);

        return { prependContext: context };
      } catch (err) {
        api.logger.warn(`sliding-context: recall failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Tools: manual search and stats
    // ========================================================================

    api.registerTool(
      {
        name: "sliding_context_search",
        description: "Search recent cross-session context. Use when you need to recall what happened recently across different sessions.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_id, params) {
          const { query, limit = 5 } = params as { query: string; limit?: number };

          const vector = await embeddings.embed(query);
          const results = await store.search(vector, limit, 0.2);

          if (results.length === 0) {
            return { content: [{ type: "text", text: "No recent context found." }] };
          }

          const now = Date.now();
          const text = results
            .map((r, i) => {
              const ago = Math.floor((now - r.entry.timestamp) / 60_000);
              const agoStr = ago < 60 ? `${ago}min` : `${Math.floor(ago / 60)}h`;
              return `${i + 1}. [${agoStr} ago · ${r.entry.sessionType}] ${r.entry.summary} (${(r.score * 100).toFixed(0)}%)`;
            })
            .join("\n");

          return { content: [{ type: "text", text }] };
        },
      },
      { optional: true },
    );

    api.registerTool(
      {
        name: "sliding_context_stats",
        description: "Show sliding context statistics (entry count, window size).",
        parameters: Type.Object({}),
        async execute() {
          const count = await store.count();
          return {
            content: [{
              type: "text",
              text: `Sliding Context: ${count} entries, ${cfg.windowHours}h window, ${cfg.recentCount} recent + ${cfg.relevantCount} relevant per turn`,
            }],
          };
        },
      },
      { optional: true },
    );

    // ========================================================================
    // CLI
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const sc = program
          .command("sliding-context")
          .alias("sc")
          .description("Sliding context plugin commands");

        sc.command("stats")
          .description("Show context statistics")
          .action(async () => {
            const count = await store.count();
            console.log(`Entries: ${count}`);
            console.log(`Window: ${cfg.windowHours}h`);
            console.log(`Inject: ${cfg.recentCount} recent + ${cfg.relevantCount} relevant (max ${cfg.maxInjectEntries})`);
            console.log(`DB: ${resolvedDbPath}`);
          });

        sc.command("list")
          .description("List recent context entries")
          .option("--limit <n>", "Max entries", "10")
          .action(async (opts) => {
            const entries = await store.getRecent(parseInt(opts.limit), cfg.windowHours);
            const now = Date.now();
            for (const e of entries) {
              const ago = Math.floor((now - e.timestamp) / 60_000);
              const agoStr = ago < 60 ? `${ago}min` : `${Math.floor(ago / 60)}h`;
              console.log(`[${agoStr} ago · ${e.sessionType}] ${e.summary}`);
            }
            if (entries.length === 0) console.log("No entries in window.");
          });

        sc.command("clear")
          .description("Clear all context entries")
          .action(async () => {
            await store.clear();
            console.log("All context entries cleared.");
          });
      },
      { commands: ["sliding-context", "sc"] },
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "sliding-context",
      start: () => {
        api.logger.info(`sliding-context: service started (window: ${cfg.windowHours}h, db: ${resolvedDbPath})`);
      },
      stop: () => {
        api.logger.info("sliding-context: stopped");
      },
    });
  },
};

export default slidingContextPlugin;
