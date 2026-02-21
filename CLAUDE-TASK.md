# Task: Deduplication & Cleanup for Sliding Context

## Overview

Two changes needed:
1. **Smart dedup at summarization time** — prevent duplicate entries from being created
2. **Cleanup script** — consolidate existing entries retroactively

## Part 1: Smart Deduplication in `summarize-llm.ts`

### Current behavior
`summarizeWithLlm()` creates a new summary for every turn, regardless of whether the topic was already covered.

### Desired behavior
Before creating a new entry, load the **last 3 entries** from the store and include them in the summarization prompt. The LLM then decides:

- **NEW** — Different topic → create new entry as normal
- **UPDATE** — Same topic but with new/evolved information → return updated summary that replaces the most recent related entry
- **SKIP** — Same topic, same information (pure duplicate) → don't create an entry

### Implementation

1. Add a new export function or extend `summarizeWithLlm` to accept recent entries as context
2. Modify the prompt to include the last 3 summaries and ask the LLM to classify as NEW/UPDATE/SKIP
3. Return an object instead of just a string: `{ action: "new" | "update" | "skip", summary: string, replaceId?: string }`
4. The caller (in `src/index.ts`) handles the action:
   - `new` → store as before
   - `update` → delete the old entry by `replaceId`, then store the new one
   - `skip` → do nothing

### Changes needed
- `src/summarize-llm.ts`: Add recent entries to prompt, parse LLM response for action
- `src/store.ts`: Add `deleteById(id: string)` method  
- `src/index.ts` (or wherever `store()` is called after summarization): Handle the three actions

### Prompt structure (append to existing summarization prompt)
```
Here are the last 3 context entries (most recent first):
[1] {summary1}
[2] {summary2}  
[3] {summary3}

Based on these existing entries, classify your response:
- If this turn covers a NEW topic not in the entries above, respond: NEW: <your summary>
- If this turn UPDATES/EVOLVES a topic from entry [N], respond: UPDATE [N]: <merged summary combining old + new>
- If this turn is essentially the SAME as an existing entry with no new info, respond: SKIP

Always respond with exactly one of: NEW: ..., UPDATE [N]: ..., or SKIP
```

### Important constraints
- Keep the existing fallback to rule-based summarization if LLM fails
- If LLM response can't be parsed (no NEW/UPDATE/SKIP prefix), treat as NEW (safe default)
- The UPDATE action should produce a merged summary, not just the new info — it replaces the old entry entirely
- Localize the prompt additions for both `de` and `en` in `src/i18n.ts`

## Part 2: Cleanup Script

Create `scripts/cleanup.ts` — a standalone script that:

1. **Backs up** the entire LanceDB database before making changes (copy the DB directory)
2. **Loads all entries** from the store
3. **Groups similar entries** using embedding similarity (cosine > 0.85 threshold)
4. **For each group of similar entries**: Uses LLM to merge them into one consolidated entry, keeping the most recent timestamp and all unique information
5. **Replaces** the group with the single merged entry
6. **Reports** what was done: "Merged X groups, reduced Y entries to Z entries"

### Usage
```bash
# From the plugin directory
npx tsx scripts/cleanup.ts --db-path /path/to/lancedb [--dry-run] [--backup-dir /path/to/backup]
```

### Flags
- `--db-path` (required): Path to the LanceDB database
- `--dry-run`: Show what would be merged without making changes
- `--backup-dir`: Where to copy the backup (default: `{db-path}.backup.{timestamp}`)
- `--similarity` (optional): Similarity threshold, default 0.85
- `--api-key` (optional): Anthropic API key (falls back to ANTHROPIC_API_KEY env var)

### Important
- The backup MUST happen before any changes
- Use the same embedding function as the main plugin for consistency
- The merge prompt should preserve: decisions, file names, numbers, emotional moments
- After cleanup, log a clear summary of changes

## General notes
- TypeScript, consistent with existing code style
- Keep imports minimal — reuse existing store/embedding/i18n code
- Test-friendly: export functions that can be unit tested
- The cleanup script should work independently (doesn't need OpenClaw running)
