/**
 * Context Node Weight Learning
 *
 * Tracks which context nodes are associated with high-quality outputs.
 * When an implicit signal arrives (true quality score), the weights of
 * every node that was included in that optimization are nudged toward
 * the reward value using a simple exponential moving average:
 *
 *   w_new = w_old * (1 - LR) + reward * LR
 *
 * v6: Time-based decay. Weights drift back to neutral (0.5) over time so
 * that stale patterns don't permanently dominate the ranking.  The drift
 * follows:
 *
 *   effective_weight = NEUTRAL + (stored - NEUTRAL) * exp(-λ * daysSince)
 *
 * where λ = ln(2) / HALF_LIFE_DAYS.  At half-life, the deviation from
 * neutral is halved.  Default half-life = 30 days.
 *
 * Weights start at 0.5 (neutral) and converge toward nodes that actually
 * help produce good responses.
 */

import * as fs from "fs";
import { getStoragePath } from "../core/storage";

const LEARNING_RATE = 0.15;   // how fast weights shift per update
const DEFAULT_WEIGHT = 0.5;   // neutral starting weight
const HALF_LIFE_DAYS = 30;    // deviation halves after 30 days of no updates
const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_DAYS;

// ─── Storage format ─────────────────────────────────────────────────────────

interface WeightEntry {
  weight: number;
  lastUpdated: number; // Unix timestamp (ms)
}

/** Raw on-disk store: can be old format (number) or new format (WeightEntry) */
type RawStore = Record<string, number | WeightEntry>;
type WeightStore = Record<string, WeightEntry>;

function getWeightsPath(): string {
  return getStoragePath("node_weights.json");
}

function loadWeights(): WeightStore {
  try {
    const raw = fs.readFileSync(getWeightsPath(), "utf-8");
    const parsed = JSON.parse(raw) as RawStore;
    const store: WeightStore = {};
    for (const [id, val] of Object.entries(parsed)) {
      if (typeof val === "number") {
        // Migrate legacy format
        store[id] = { weight: val, lastUpdated: Date.now() };
      } else {
        store[id] = val;
      }
    }
    return store;
  } catch {
    return {};
  }
}

function saveWeights(store: WeightStore): void {
  try {
    fs.writeFileSync(getWeightsPath(), JSON.stringify(store, null, 2), "utf-8");
  } catch (e) {
    console.error("[Copilot Optimizer] Failed to save node weights:", e);
  }
}

// ─── Decay ──────────────────────────────────────────────────────────────────

/**
 * Apply time-based decay: drift the weight back toward neutral (0.5).
 * A weight of 0.9 after 30 days becomes 0.5 + (0.9-0.5)*0.5 = 0.7.
 */
function decayedWeight(entry: WeightEntry): number {
  const daysSince = (Date.now() - entry.lastUpdated) / 86_400_000;
  return DEFAULT_WEIGHT + (entry.weight - DEFAULT_WEIGHT) * Math.exp(-DECAY_LAMBDA * daysSince);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the learned weight for a node (0..1, default 0.5).
 * Weights > 0.5 = historically helpful; < 0.5 = historically unhelpful.
 * Decay is applied transparently on every read.
 */
export function getNodeWeight(nodeId: string): number {
  const store = loadWeights();
  const entry = store[nodeId];
  if (!entry) return DEFAULT_WEIGHT;
  return decayedWeight(entry);
}

/**
 * Update weights for a set of nodes using the reward from an implicit signal.
 * Decay is applied before the EMA update so stale weights are corrected first.
 *
 * @param nodeIds - IDs of context nodes that were used in this optimization
 * @param reward  - true quality score (0..1) derived from ImplicitSignal
 */
export function updateNodeWeights(nodeIds: string[], reward: number): void {
  if (nodeIds.length === 0) return;
  const store = loadWeights();
  for (const id of nodeIds) {
    const entry = store[id];
    const current = entry ? decayedWeight(entry) : DEFAULT_WEIGHT;
    store[id] = {
      weight: current * (1 - LEARNING_RATE) + reward * LEARNING_RATE,
      lastUpdated: Date.now(),
    };
  }
  saveWeights(store);
}

/**
 * Returns all stored weights with decay applied (for dashboard display).
 */
export function getAllNodeWeights(): Record<string, number> {
  const store = loadWeights();
  return Object.fromEntries(
    Object.entries(store).map(([id, entry]) => [id, decayedWeight(entry)])
  );
}

/**
 * Returns the top-N most helpful node names by (decayed) weight.
 * Used in dashboard summary.
 */
export function getTopNodes(
  n: number
): Array<{ nodeId: string; weight: number }> {
  const store = loadWeights();
  return Object.entries(store)
    .map(([nodeId, entry]) => ({ nodeId, weight: decayedWeight(entry) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n);
}

