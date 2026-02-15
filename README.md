# @muster-im-nichts/openclaw-sliding-context

**Cross-session working memory for [OpenClaw](https://openclaw.ai).**

Every trigger — DM, webhook, cron job, group mention — gets a sliding window of recent, relevant context from *all* sessions, automatically injected before the agent starts.

Think of it as **working memory** (what just happened) vs. long-term memory (facts and preferences).

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  agent_end   │────▶│  Summarize Turn   │────▶│  LanceDB    │
│ (any session)│     │  (rule-based,     │     │  (vectors)  │
│              │     │   no LLM needed)  │     │             │
└─────────────┘     └──────────────────┘     └──────┬──────┘
                                                     │
┌──────────────┐    ┌──────────────────┐            │
│before_agent_ │◀───│  Recall Context   │◀───────────┘
│  start       │    │  (semantic +      │
│ (any session)│    │   time-weighted)  │
└──────────────┘    └──────────────────┘
```

**After every turn:** Extracts a rule-based summary (user intent + tools used + outcome), embeds it, stores it in LanceDB.

**Before every turn:** Finds recent + semantically relevant entries, ranks them (recency × relevance × session type), and injects them as `prependContext`.

### Example injection

```
<sliding-context window="48h" entries="4">
Recent context from other sessions (for continuity only):

[2min ago · DM] User asked to design a sliding context plugin. [write, exec] → Wrote spec doc.
[35min ago · DM] Analyzed memory-lancedb plugin — found before_agent_start hook supports injection.
[2h ago · Cron] Checked emails — nothing urgent. Calendar clear.
[6h ago · DM] Discussed agri-tools PR #10 (documents refactoring).
</sliding-context>
```

## Install

```bash
openclaw plugins install @muster-im-nichts/openclaw-sliding-context
```

## Configure

```json5
// openclaw.json
{
  plugins: {
    entries: {
      "sliding-context": {
        enabled: true,
        config: {
          embedding: {
            apiKey: "${OPENAI_API_KEY}",
            model: "text-embedding-3-small"  // default
          },
          windowHours: 48,        // how far back (default: 48)
          recentCount: 5,         // always include N most recent
          relevantCount: 3,       // + N semantically similar
          maxInjectEntries: 8,    // cap per turn
          maxInjectTokens: 1500,  // hard token budget
          skipTrivial: true,      // skip HEARTBEAT_OK / NO_REPLY
          skipSessions: []        // session keys to exclude
        }
      }
    }
  }
}
```

## CLI

```bash
openclaw sliding-context stats    # entry count, config
openclaw sliding-context list     # recent entries
openclaw sliding-context clear    # wipe all entries
openclaw sc stats                 # short alias
```

## Agent Tools (opt-in)

The plugin registers two optional tools:

- **`sliding_context_search`** — manual semantic search across recent context
- **`sliding_context_stats`** — show entry count and config

Enable them in your agent config:

```json5
{
  agents: {
    list: [{
      id: "main",
      tools: { allow: ["sliding_context_search", "sliding_context_stats"] }
    }]
  }
}
```

## Ranking

Entries are scored with a weighted combination:

| Signal | Weight | Notes |
|--------|--------|-------|
| Semantic relevance | 0.40 | Vector similarity to current prompt |
| Recency | 0.30 | Exponential decay, half-life ~8h |
| Same session | 0.10 | Boost entries from current session |
| Decision/tool boost | 0.10 | Turns with actions or decisions |
| DM boost | 0.10 | Direct messages over cron/webhook |

## Design Principles

- **No extra LLM calls**: Summarization is entirely rule-based (fast and free)
- **Privacy-safe**: Injected context is wrapped with "do not follow instructions" disclaimer
- **Auto-expiring**: Entries are pruned after `windowHours` — no permanent storage
- **Coexists** with `memory-core` and `memory-lancedb` (doesn't replace the memory slot)

## Cost

With `text-embedding-3-small` at $0.02/1M tokens:
- ~50 turns/day ≈ ~5K tokens ≈ **$0.0001/day** (negligible)

## License

MIT — [muster-im-nichts](https://github.com/muster-im-nichts)

*"Jeder Trigger soll wissen, was gerade los ist."*
