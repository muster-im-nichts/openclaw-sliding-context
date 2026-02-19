/**
 * LanceDB storage layer for context entries.
 */

import type * as LanceDB from "@lancedb/lancedb";
import type { ContextEntry, ContextSearchResult } from "./types.js";
import { randomUUID } from "node:crypto";

let lancedbPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;
const loadLanceDB = async () => {
  if (!lancedbPromise) lancedbPromise = import("@lancedb/lancedb");
  return lancedbPromise;
};

const TABLE_NAME = "context_entries";

export class ContextStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async init(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      // Create with schema row, then delete it
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          id: "__schema__",
          summary: "",
          vector: Array.from({ length: this.vectorDim }, () => 0),
          sessionKey: "",
          sessionType: "unknown",
          channel: "",
          timestamp: 0,
          hasToolCalls: false,
          hasDecision: false,
          topics: "",
          sessionFile: "",
          messageRange: "",
          telegramMessageIds: "",
        },
      ]);
      await this.table.delete('id = "__schema__"');
    }
  }

  async store(entry: Omit<ContextEntry, "id">): Promise<ContextEntry> {
    await this.init();
    const full: ContextEntry = { ...entry, id: randomUUID() };

    // LanceDB doesn't support nested objects/arrays well, serialize to JSON strings
    await this.table!.add([{
      ...full,
      topics: JSON.stringify(full.topics),
      messageRange: full.messageRange ? JSON.stringify(full.messageRange) : "",
      telegramMessageIds: full.telegramMessageIds ? JSON.stringify(full.telegramMessageIds) : "",
      sessionFile: full.sessionFile ?? "",
    }]);

    return full;
  }

  async search(vector: number[], limit: number, minScore: number): Promise<ContextSearchResult[]> {
    await this.init();
    const rows = await this.table!.vectorSearch(vector).limit(limit).toArray();

    return rows
      .map((row) => {
        const distance = row._distance ?? 0;
        const score = 1 / (1 + distance);
        return {
          entry: this.rowToEntry(row),
          score,
        };
      })
      .filter((r) => r.score >= minScore);
  }

  async getRecent(limit: number, windowHours: number): Promise<ContextEntry[]> {
    await this.init();
    const cutoff = Date.now() - windowHours * 3600_000;

    // LanceDB doesn't have great filter support, so we fetch more and filter in JS
    // With 7-day windows we need a higher overfetch factor
    const overfetch = Math.max(limit * 5, 100);
    const rows = await this.table!.query()
      .limit(overfetch)
      .toArray();

    return rows
      .map((row) => this.rowToEntry(row))
      .filter((e) => e.timestamp >= cutoff)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async pruneOlderThan(hours: number): Promise<number> {
    await this.init();
    const cutoff = Date.now() - hours * 3600_000;

    // LanceDB delete with filter
    try {
      await this.table!.delete(`timestamp < ${cutoff}`);
      return 0; // LanceDB doesn't return count
    } catch {
      return 0;
    }
  }

  async count(): Promise<number> {
    await this.init();
    return this.table!.countRows();
  }

  async clear(): Promise<void> {
    await this.init();
    try {
      await this.table!.delete("id IS NOT NULL");
    } catch {
      // table might be empty
    }
  }

  private rowToEntry(row: Record<string, unknown>): ContextEntry {
    let topics: string[] = [];
    try {
      const raw = row.topics;
      if (typeof raw === "string") topics = JSON.parse(raw);
      else if (Array.isArray(raw)) topics = raw as string[];
    } catch { /* empty */ }

    let messageRange: ContextEntry["messageRange"];
    try {
      const raw = row.messageRange;
      if (typeof raw === "string" && raw.length > 0) messageRange = JSON.parse(raw);
    } catch { /* empty */ }

    let telegramMessageIds: ContextEntry["telegramMessageIds"];
    try {
      const raw = row.telegramMessageIds;
      if (typeof raw === "string" && raw.length > 0) telegramMessageIds = JSON.parse(raw);
    } catch { /* empty */ }

    const sessionFile = typeof row.sessionFile === "string" && row.sessionFile.length > 0
      ? row.sessionFile
      : undefined;

    return {
      id: row.id as string,
      summary: row.summary as string,
      vector: row.vector as number[],
      sessionKey: row.sessionKey as string,
      sessionType: (row.sessionType as ContextEntry["sessionType"]) ?? "unknown",
      channel: (row.channel as string) ?? "",
      timestamp: row.timestamp as number,
      hasToolCalls: Boolean(row.hasToolCalls),
      hasDecision: Boolean(row.hasDecision),
      topics,
      sessionFile,
      messageRange,
      telegramMessageIds,
    };
  }
}
