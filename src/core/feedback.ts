import * as path from "path";
import * as fs from "fs";
import { updateNodeWeights } from "../context/nodeWeights";

// ─── Implicit signal ─────────────────────────────────────────────────────────

/** How the user actually used the optimized prompt — the real quality signal */
export type ImplicitSignal =
  | "accepted_without_edit"
  | "accepted_with_edit"
  | "regenerated"
  | "ignored";

/** Translate an implicit signal into a 0–1 true quality score */
export function computeTrueQualityScore(signal: ImplicitSignal): number {
  switch (signal) {
    case "accepted_without_edit": return 1.0;
    case "accepted_with_edit":    return 0.65;
    case "regenerated":           return 0.2;
    case "ignored":               return 0.0;
  }
}

export interface FeedbackEntry {
  id: string;
  timestamp: string;
  prompt: string;
  optimized: string;
  intent: string;
  strategy: string;
  accepted: boolean;
  retries: number;
  editDistance: number;
  tokensSaved: number;
  /** Optional: how the user actually used the result (for true quality scoring) */
  implicitSignal?: ImplicitSignal;
  /** Derived from implicitSignal: 0–1 */
  trueQualityScore?: number;
  /** IDs of context nodes used in this optimization (for adaptive graph learning) */
  contextNodeIds?: string[];
}

export interface FeedbackStats {
  totalEntries: number;
  acceptanceRate: number;
  avgTokensSaved: number;  /** Average of trueQualityScore (only entries that have an implicit signal) */
  avgTrueQuality: number;
  /** Count per implicit signal type */
  signalDistribution: Partial<Record<ImplicitSignal, number>>;  byIntent: Record<
    string,
    { count: number; acceptRate: number; avgTokensSaved: number }
  >;
  bestStrategies: Record<string, string>;
  /** Learned weighted strategies per intent (requires >= 3 samples) */
  learnedStrategies: Record<string, string>;
}

function getLogsPath(): string {
  return path.join(__dirname, "..", "..", "data", "logs.json");
}

function generateId(): string {
  return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function loadLogs(): FeedbackEntry[] {
  try {
    const raw = fs.readFileSync(getLogsPath(), "utf-8");
    return JSON.parse(raw) as FeedbackEntry[];
  } catch {
    return [];
  }
}

function saveLogs(entries: FeedbackEntry[]): void {
  try {
    fs.writeFileSync(getLogsPath(), JSON.stringify(entries, null, 2), "utf-8");
  } catch (e) {
    console.error("[Copilot Optimizer] Failed to save feedback logs:", e);
  }
}

export function logFeedback(
  prompt: string,
  optimized: string,
  intent: string,
  strategy: string,
  accepted: boolean,
  retries: number,
  tokensSaved: number,
  finalPrompt?: string,
  implicitSignal?: ImplicitSignal,
  contextNodeIds?: string[]
): FeedbackEntry {
  const entries = loadLogs();
  const editDistance = finalPrompt
    ? levenshtein(optimized, finalPrompt) / Math.max(optimized.length, 1)
    : 0;

  const trueQualityScore = implicitSignal !== undefined ? computeTrueQualityScore(implicitSignal) : undefined;

  // Adaptive graph: nudge node weights toward this reward signal
  if (trueQualityScore !== undefined && contextNodeIds && contextNodeIds.length > 0) {
    updateNodeWeights(contextNodeIds, trueQualityScore);
  }

  const entry: FeedbackEntry = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    prompt,
    optimized,
    intent,
    strategy,
    accepted,
    retries,
    editDistance,
    tokensSaved,
    implicitSignal,
    trueQualityScore,
    contextNodeIds,
  };

  entries.push(entry);

  // Keep rolling window of 1 000 entries
  if (entries.length > 1000) entries.splice(0, entries.length - 1000);

  saveLogs(entries);
  return entry;
}

export function getStats(): FeedbackStats {
  const entries = loadLogs();

  if (entries.length === 0) {
    return {
      totalEntries: 0,
      acceptanceRate: 0,
      avgTokensSaved: 0,
      avgTrueQuality: 0,
      signalDistribution: {},
      byIntent: {},
      bestStrategies: {},
      learnedStrategies: {},
    };
  }

  const acceptedCount = entries.filter((e) => e.accepted).length;
  const totalTokens = entries.reduce((sum, e) => sum + e.tokensSaved, 0);

  const byIntentAccum: Record<
    string,
    { count: number; accepted: number; tokens: number }
  > = {};

  for (const entry of entries) {
    if (!byIntentAccum[entry.intent]) {
      byIntentAccum[entry.intent] = { count: 0, accepted: 0, tokens: 0 };
    }
    byIntentAccum[entry.intent].count++;
    if (entry.accepted) byIntentAccum[entry.intent].accepted++;
    byIntentAccum[entry.intent].tokens += entry.tokensSaved;
  }

  const byIntent: FeedbackStats["byIntent"] = {};
  const bestStrategies: Record<string, string> = {};

  for (const [intent, data] of Object.entries(byIntentAccum)) {
    byIntent[intent] = {
      count: data.count,
      acceptRate: data.count > 0 ? data.accepted / data.count : 0,
      avgTokensSaved: data.count > 0 ? data.tokens / data.count : 0,
    };

    // Find best strategy for this intent by acceptance rate
    const stratMap: Record<string, { count: number; accepted: number }> = {};
    for (const e of entries.filter((e) => e.intent === intent)) {
      if (!stratMap[e.strategy]) stratMap[e.strategy] = { count: 0, accepted: 0 };
      stratMap[e.strategy].count++;
      if (e.accepted) stratMap[e.strategy].accepted++;
    }

    let bestStrat = "moderate";
    let bestRate = -1;
    for (const [strat, s] of Object.entries(stratMap)) {
      const rate = s.count > 0 ? s.accepted / s.count : 0;
      if (rate > bestRate) {
        bestRate = rate;
        bestStrat = strat;
      }
    }
    bestStrategies[intent] = bestStrat;
  }

  // True quality (implicit signal) stats
  const signalEntries = entries.filter((e) => e.trueQualityScore !== undefined);
  const avgTrueQuality = signalEntries.length > 0
    ? signalEntries.reduce((s, e) => s + (e.trueQualityScore ?? 0), 0) / signalEntries.length
    : 0;

  const signalDistribution: Partial<Record<ImplicitSignal, number>> = {};
  for (const e of entries) {
    if (e.implicitSignal) {
      signalDistribution[e.implicitSignal] = (signalDistribution[e.implicitSignal] ?? 0) + 1;
    }
  }

  return {
    totalEntries: entries.length,
    acceptanceRate: acceptedCount / entries.length,
    avgTokensSaved: totalTokens / entries.length,
    avgTrueQuality,
    signalDistribution,
    byIntent,
    bestStrategies,
    learnedStrategies: Object.fromEntries(
      Object.keys(byIntentAccum).map((intent) => [intent, getWeightedStrategy(intent)])
    ),
  };
}

export function getAdaptiveStrategy(
  intent: string
): "minimal" | "moderate" | "aggressive" {
  const stats = getStats();
  const best = stats.bestStrategies[intent];
  if (best === "minimal" || best === "moderate" || best === "aggressive") {
    return best;
  }
  // Fallback defaults
  if (intent === "debug" || intent === "fix") return "minimal";
  if (intent === "generate") return "aggressive";
  return "moderate";
}

// ─── Weighted strategy (learning feedback) ───────────────────────────────────

interface StrategyWeight {
  strategy: "minimal" | "moderate" | "aggressive";
  weight: number;
}

/**
 * Returns the best compression strategy for an intent weighted by historical
 * success_rate and avg_tokens_saved.  Falls back to intent defaults when
 * there is insufficient data (< 3 samples per strategy).
 */
export function getWeightedStrategy(
  intent: string
): "minimal" | "moderate" | "aggressive" {
  const entries = loadLogs().filter((e) => e.intent === intent);

  type Key = "minimal" | "moderate" | "aggressive";
  const buckets: Record<Key, { accepted: number; count: number; tokens: number }> = {
    minimal:    { accepted: 0, count: 0, tokens: 0 },
    moderate:   { accepted: 0, count: 0, tokens: 0 },
    aggressive: { accepted: 0, count: 0, tokens: 0 },
  };

  for (const e of entries) {
    const key = e.strategy as Key;
    if (!buckets[key]) continue;
    buckets[key].count++;
    if (e.accepted) buckets[key].accepted++;
    buckets[key].tokens += e.tokensSaved;
  }

  const weights: StrategyWeight[] = (Object.entries(buckets) as [Key, typeof buckets[Key]][])
    .filter(([, b]) => b.count >= 3) // need at least 3 samples to trust
    .map(([strategy, b]) => {
      const successRate = b.accepted / b.count;
      const normTokens = b.count > 0 ? b.tokens / b.count / 50 : 0; // normalise ~50 tokens = 1.0
      // weight = success_rate * 0.7 + normalised_tokens * 0.3
      return { strategy, weight: successRate * 0.7 + Math.min(normTokens, 1) * 0.3 };
    });

  if (weights.length === 0) {
    // Not enough data — use defaults
    if (intent === "debug" || intent === "fix") return "minimal";
    if (intent === "generate") return "aggressive";
    return "moderate";
  }

  weights.sort((a, b) => b.weight - a.weight);
  return weights[0].strategy;
}
