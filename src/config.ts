/**
 * Configuration parsing and defaults for the sliding context plugin.
 */

export type SlidingContextConfig = {
  embedding: {
    apiKey: string;
    model: string;
  };
  summarization: {
    mode: "rule-based" | "llm";
    apiKey?: string;
    model: string;
  };
  dbPath: string;
  windowHours: number;
  decayHalfLifeHours: number;
  recentCount: number;
  relevantCount: number;
  maxInjectEntries: number;
  maxInjectTokens: number;
  summaryMaxChars: number;
  skipTrivial: boolean;
  skipSessions: string[];
};

const DEFAULTS = {
  model: "text-embedding-3-small",
  summarizationModel: "claude-sonnet-4-20250514",
  dbPath: "~/.openclaw/sliding-context/lancedb",
  windowHours: 48,
  decayHalfLifeHours: 18,
  recentCount: 5,
  relevantCount: 3,
  maxInjectEntries: 8,
  maxInjectTokens: 1500,
  summaryMaxChars: 200,
  skipTrivial: true,
  skipSessions: [] as string[],
} as const;

const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(`Unsupported embedding model: ${model}. Supported: ${Object.keys(EMBEDDING_DIMENSIONS).join(", ")}`);
  }
  return dims;
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar: string) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export function parseConfig(raw: unknown): SlidingContextConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("sliding-context: config object required");
  }

  const cfg = raw as Record<string, unknown>;

  // Embedding (required)
  const embedding = cfg.embedding as Record<string, unknown> | undefined;
  if (!embedding || typeof embedding.apiKey !== "string") {
    throw new Error("sliding-context: embedding.apiKey is required");
  }

  const model = typeof embedding.model === "string" ? embedding.model : DEFAULTS.model;
  vectorDimsForModel(model); // validate

  // Summarization config
  const summarization = cfg.summarization as Record<string, unknown> | undefined;
  const sumMode = summarization?.mode === "rule-based" ? "rule-based" : "llm"; // default: llm
  const sumApiKey = typeof summarization?.apiKey === "string"
    ? resolveEnvVars(summarization.apiKey)
    : undefined;
  const sumModel = typeof summarization?.model === "string"
    ? summarization.model
    : DEFAULTS.summarizationModel;

  return {
    embedding: {
      apiKey: resolveEnvVars(embedding.apiKey),
      model,
    },
    summarization: {
      mode: sumMode,
      apiKey: sumApiKey,
      model: sumModel,
    },
    dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : DEFAULTS.dbPath,
    windowHours: num(cfg.windowHours, DEFAULTS.windowHours),
    decayHalfLifeHours: num(cfg.decayHalfLifeHours, DEFAULTS.decayHalfLifeHours),
    recentCount: num(cfg.recentCount, DEFAULTS.recentCount),
    relevantCount: num(cfg.relevantCount, DEFAULTS.relevantCount),
    maxInjectEntries: num(cfg.maxInjectEntries, DEFAULTS.maxInjectEntries),
    maxInjectTokens: num(cfg.maxInjectTokens, DEFAULTS.maxInjectTokens),
    summaryMaxChars: num(cfg.summaryMaxChars, DEFAULTS.summaryMaxChars),
    skipTrivial: typeof cfg.skipTrivial === "boolean" ? cfg.skipTrivial : DEFAULTS.skipTrivial,
    skipSessions: Array.isArray(cfg.skipSessions) ? cfg.skipSessions.filter((s): s is string => typeof s === "string") : DEFAULTS.skipSessions,
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
