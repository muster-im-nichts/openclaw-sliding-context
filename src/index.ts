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
  extractMessageRange,
  extractTelegramMessageIds,
} from "./summarize.js";
import { summarizeWithLlm, type SummarizeResult } from "./summarize-llm.js";
import { deduplicateAndRank, splitChronologicalAndRanked } from "./ranking.js";
import { formatSlidingContext } from "./format.js";
import { generateTimeline } from "./timeline.js";
import { t } from "./i18n.js";

const slidingContextPlugin = {
  id: "sliding-context",
  name: "Sliding Context",
  description: "Cross-session working memory with sliding context window",

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    const resolvedDbPath = api.resolvePath(cfg.dbPath);
    const vectorDim = vectorDimsForModel(cfg.embedding.model);
    const store = new ContextStore(resolvedDbPath, vectorDim);
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      cfg.embedding.model,
    );

    api.logger.info(
      `sliding-context: registered (db: ${resolvedDbPath}, window: ${cfg.windowHours}h)`,
    );

    // ========================================================================
    // Capture: index turn summaries after every agent turn
    // ========================================================================

    api.on("agent_end", async (event) => {
      const messages = event.messages as unknown[] | undefined;
      if (!messages || messages.length === 0) return;

      // Skip trivial turns (HEARTBEAT_OK, NO_REPLY)
      if (cfg.skipTrivial && isTrivialTurn(messages)) return;

      // Skip excluded sessions
      const sessionKey =
        ((event as Record<string, unknown>).sessionKey as string | undefined) ??
        "unknown";
      if (cfg.skipSessions.includes(sessionKey)) return;

      try {
        // Load recent entries for dedup context (LLM mode only)
        const recentEntries =
          cfg.summarization.mode === "llm"
            ? await store.getRecent(3, cfg.windowHours)
            : [];

        // Extract summary (LLM or rule-based)
        let result: SummarizeResult;
        if (cfg.summarization.mode === "llm") {
          const llmApiKey = cfg.summarization.apiKey ?? cfg.embedding.apiKey;
          result = await summarizeWithLlm(
            messages,
            {
              apiKey: llmApiKey,
              model: cfg.summarization.model,
              maxChars: cfg.summaryMaxChars,
              locale: cfg.locale,
            },
            api.logger,
            recentEntries,
          );
        } else {
          const summary = extractTurnSummary(messages, cfg.summaryMaxChars);
          result = { action: "new", summary };
        }

        // Handle SKIP — nothing to store
        if (result.action === "skip") {
          api.logger.debug?.(
            `sliding-context: skipped duplicate turn from ${sessionKey}`,
          );
          return;
        }

        const { summary } = result;
        if (!summary || summary.length < 10) return;

        // Handle UPDATE — delete the old entry first
        if (result.action === "update" && result.replaceId) {
          await store.deleteById(result.replaceId);
          api.logger.debug?.(
            `sliding-context: updating entry ${result.replaceId} from ${sessionKey}`,
          );
        }

        // Embed
        const vector = await embeddings.embed(summary);

        // Deep Recall references
        const messageRange = extractMessageRange(messages);
        const telegramMessageIds = extractTelegramMessageIds(messages);

        // Session file: derive from sessionKey (e.g. "telegram:main:abc123" → abc123.jsonl)
        const sessionId = sessionKey.split(":").pop() ?? sessionKey;
        const sessionFile = `/root/.openclaw/agents/main/sessions/${sessionId}.jsonl`;

        // Store
        await store.store({
          summary,
          vector,
          sessionKey,
          sessionType: detectSessionType(sessionKey),
          channel: ((event as Record<string, unknown>).channel as string) ?? "",
          timestamp: Date.now(),
          hasToolCalls: hasToolCallsInTurn(messages),
          hasDecision: hasDecisionSignal(messages),
          topics: extractTopics(messages),
          sessionFile,
          messageRange,
          telegramMessageIds:
            telegramMessageIds.length > 0 ? telegramMessageIds : undefined,
        });

        // Prune expired entries
        await store.pruneOlderThan(cfg.windowHours);

        api.logger.debug?.(
          `sliding-context: captured turn from ${sessionKey} (${result.action}, ${summary.length} chars)`,
        );
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

      const sessionKey =
        ((event as Record<string, unknown>).sessionKey as string | undefined) ??
        "unknown";

      try {
        // Three-pass retrieval
        const now = Date.now();

        // Pass 1 + 2 in parallel: recent entries + embed prompt for semantic search
        const [recent, vector] = await Promise.all([
          store.getRecent(cfg.recentCount + cfg.relevantCount, cfg.windowHours),
          embeddings.embed(prompt),
        ]);

        const relevant = await store.search(vector, cfg.relevantCount, 0.3);

        // Merge, rank, deduplicate
        const merged = deduplicateAndRank(recent, relevant, {
          currentSession: sessionKey,
          now,
          maxEntries: cfg.maxInjectEntries,
          decayHalfLifeHours: cfg.decayHalfLifeHours,
        });

        if (merged.length === 0) return;

        // Split into chronological (recent window) and ranked (older)
        const { chronological, ranked } = splitChronologicalAndRanked(
          merged,
          cfg.recentWindowHours,
          now,
        );

        // Format for injection
        const context = formatSlidingContext(chronological, ranked, {
          maxTokens: cfg.maxInjectTokens,
          windowHours: cfg.windowHours,
          locale: cfg.locale,
        });

        if (!context) return;

        // Pass 3: Timeline block (filesystem only, no API calls)
        let fullContext = context;
        if (cfg.timeline.enabled) {
          try {
            const workspacePath =
              ((api as Record<string, unknown>).workspace as
                | string
                | undefined) ?? cfg.timeline.workspacePath;
            const timeline = await generateTimeline(workspacePath, cfg.locale);
            if (timeline) {
              fullContext = context + "\n" + timeline;
            }
          } catch {
            // Timeline is optional — failures are silent
          }
        }

        const totalEntries = chronological.length + ranked.length;
        api.logger.info?.(
          `sliding-context: injecting ${totalEntries} entries (${chronological.length} chrono + ${ranked.length} ranked) into ${sessionKey}`,
        );

        return { prependContext: fullContext };
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
        description:
          "Search recent cross-session context. Use when you need to recall what happened recently across different sessions.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default: 5)" }),
          ),
        }),
        async execute(_id, params) {
          const { query, limit = 5 } = params as {
            query: string;
            limit?: number;
          };

          const vector = await embeddings.embed(query);
          const results = await store.search(vector, limit, 0.2);

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: "No recent context found." }],
            };
          }

          const now = Date.now();
          const text = results
            .map((r, i) => {
              const ago = Math.floor((now - r.entry.timestamp) / 60_000);
              const agoStr =
                ago < 60 ? `${ago}min` : `${Math.floor(ago / 60)}h`;
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
        description:
          "Show sliding context statistics (entry count, window size).",
        parameters: Type.Object({}),
        async execute() {
          const count = await store.count();
          return {
            content: [
              {
                type: "text",
                text: `Sliding Context: ${count} entries, ${cfg.windowHours}h window (${cfg.recentWindowHours}h chronological), ${cfg.recentCount} recent + ${cfg.relevantCount} relevant per turn, timeline: ${cfg.timeline.enabled ? "on" : "off"}`,
              },
            ],
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
            const s = t(cfg.locale);
            const count = await store.count();
            console.log(`${s.statsEntries}: ${count}`);
            console.log(
              `${s.statsWindow}: ${cfg.windowHours}h (recent: ${cfg.recentWindowHours}h chronological)`,
            );
            console.log(
              `Inject: ${cfg.recentCount} recent + ${cfg.relevantCount} relevant (max ${cfg.maxInjectEntries}, max ${cfg.maxInjectTokens} tokens)`,
            );
            console.log(`Summary: max ${cfg.summaryMaxChars} chars`);
            console.log(
              `${s.statsTimeline}: ${cfg.timeline.enabled ? "enabled" : "disabled"}`,
            );
            console.log(`Locale: ${cfg.locale}`);
            console.log(`DB: ${resolvedDbPath}`);
          });

        sc.command("list")
          .description("List recent context entries")
          .option("--limit <n>", "Max entries", "10")
          .action(async (opts) => {
            const entries = await store.getRecent(
              parseInt(opts.limit),
              cfg.windowHours,
            );
            const now = Date.now();
            for (const e of entries) {
              const ago = Math.floor((now - e.timestamp) / 60_000);
              const agoStr =
                ago < 60 ? `${ago}min` : `${Math.floor(ago / 60)}h`;
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
        api.logger.info(
          `sliding-context: service started (window: ${cfg.windowHours}h, db: ${resolvedDbPath})`,
        );
      },
      stop: () => {
        api.logger.info("sliding-context: stopped");
      },
    });
  },
};

export default slidingContextPlugin;
