/**
 * Strategy Memory Cache
 *
 * Caches the best-performing strategy variant per (intent × context fingerprint).
 * Key = hash of intent + sorted top-N context node names.
 *
 * v6: Fuzzy matching via Jaccard similarity so that small context changes
 * (e.g. one extra logger file) still hit the cache instead of forcing a
 * full 4-variant search.
 */

import * as path from "path";
import * as fs from "fs";

type StrategyLabel = "minimal" | "moderate" | "aggressive";

interface CacheEntry {
  strategy: StrategyLabel;
  /** Best true quality score ever seen for this key */
  bestScore: number;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** How many times this key has been looked up (exact + fuzzy) */
  hits: number;
  /** Context node names stored for fuzzy similarity matching */
  contextNodeNames: string[];
  /** Intent stored alongside node names */
  intent: string;
}

type CacheStore = Record<string, CacheEntry>;

function getCachePath(): string {
  return path.join(__dirname, "..", "..", "data", "strategy_cache.json");
}

function loadCache(): CacheStore {
  try {
    const raw = fs.readFileSync(getCachePath(), "utf-8");
    return JSON.parse(raw) as CacheStore;
  } catch {
    return {};
  }
}

function saveCache(store: CacheStore): void {
  try {
    fs.writeFileSync(getCachePath(), JSON.stringify(store, null, 2), "utf-8");
  } catch (e) {
    console.error("[Copilot Optimizer] Failed to save strategy cache:", e);
  }
}

// ─── Similarity ────────────────────────────────────────────────────────────────

/**
 * Jaccard similarity between two sets of node names.
 * Returns 0..1 (1.0 = identical sets).
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a.map((s) => s.toLowerCase()));
  const setB = new Set(b.map((s) => s.toLowerCase()));
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds a stable cache key from intent + context node names.
 * Sorts node names so order doesn’t affect the key.
 */
export function buildCacheKey(intent: string, contextNodeNames: string[]): string {
  const sortedNames = [...contextNodeNames].sort().join(",");
  // Simple djb2-style hash — no external deps
  let hash = 5381;
  const str = `${intent}:${sortedNames}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // keep unsigned 32-bit
  }
  return `${intent}_${hash.toString(16)}`;
}

/**
 * Look up the best cached strategy for a context.
 *
 * Strategy:
 * 1. Exact key match (O(1))
 * 2. Fuzzy match: find the cached entry for the same intent whose context
 *    node set has Jaccard similarity ≥ threshold with the current set.
 *
 * Returns the matched strategy label or undefined when no good match exists.
 */
export function lookupStrategyCacheFuzzy(
  key: string,
  intent: string,
  contextNodeNames: string[],
  similarityThreshold = 0.8
): { strategy: StrategyLabel; similarity: number; isFuzzy: boolean } | undefined {
  const store = loadCache();

  // 1. Exact match
  const exact = store[key];
  if (exact) {
    exact.hits++;
    saveCache(store);
    return { strategy: exact.strategy, similarity: 1.0, isFuzzy: false };
  }

  // 2. Fuzzy match — same intent, best similarity above threshold
  let bestEntry: CacheEntry | undefined;
  let bestSim = similarityThreshold - 0.001; // must beat threshold to win

  for (const entry of Object.values(store)) {
    if (entry.intent !== intent) continue;
    if (!entry.contextNodeNames) continue; // old entry without names
    const sim = jaccardSimilarity(contextNodeNames, entry.contextNodeNames);
    if (sim > bestSim) {
      bestSim = sim;
      bestEntry = entry;
    }
  }

  if (bestEntry) {
    bestEntry.hits++;
    saveCache(store);
    return { strategy: bestEntry.strategy, similarity: bestSim, isFuzzy: true };
  }

  return undefined;
}

/** @deprecated Use lookupStrategyCacheFuzzy */
export function lookupStrategyCache(key: string): StrategyLabel | undefined {
  const store = loadCache();
  const entry = store[key];
  if (!entry) return undefined;
  entry.hits++;
  saveCache(store);
  return entry.strategy;
}

/**
 * Update (or create) a cache entry when a new true quality score arrives.
 * Only overwrites if the new score beats the stored best.
 */
export function updateStrategyCache(
  key: string,
  strategy: StrategyLabel,
  trueQualityScore: number,
  contextNodeNames: string[] = [],
  intent = ""
): void {
  const store = loadCache();
  const existing = store[key];
  if (!existing || trueQualityScore > existing.bestScore) {
    store[key] = {
      strategy,
      bestScore: trueQualityScore,
      updatedAt: new Date().toISOString(),
      hits: existing?.hits ?? 0,
      contextNodeNames,
      intent,
    };
    saveCache(store);
  }
}

/**
 * Returns aggregate cache stats for the dashboard.
 */
export function getCacheStats(): {
  totalEntries: number;
  totalHits: number;
  fuzzyCapable: number; // entries that have contextNodeNames stored
  topEntries: Array<{ key: string; strategy: StrategyLabel; bestScore: number; hits: number }>;
} {
  const store = loadCache();
  const entries = Object.entries(store).map(([key, e]) => ({ key, ...e }));
  const totalHits = entries.reduce((s, e) => s + e.hits, 0);
  const fuzzyCapable = entries.filter((e) => e.contextNodeNames && e.contextNodeNames.length > 0).length;
  const topEntries = entries
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 10)
    .map(({ key, strategy, bestScore, hits }) => ({ key, strategy, bestScore, hits }));
  return { totalEntries: entries.length, totalHits, fuzzyCapable, topEntries };
}
