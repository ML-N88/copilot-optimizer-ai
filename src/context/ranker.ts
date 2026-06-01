import { ContextGraph, GraphNode } from "./graph";
import { Intent } from "../core/intent";
import { intentMatchScore, getStrategy } from "../core/strategy";
import { getNodeWeight } from "./nodeWeights";

export interface RankedNode {
  node: GraphNode;
  score: number;
  rank: number;
  role: string; // structured context label
}

// Score = semantic*0.35 + callFreq*0.12 + proximity*0.13 + recency*0.1 + intentMatch*0.2 + learnedWeight*0.1
const WEIGHTS = {
  semanticSimilarity: 0.35,
  callFrequency: 0.12,
  fileProximity: 0.13,
  recency: 0.1,
  intentMatch: 0.2,
  learnedWeight: 0.1,  // NEW: adaptive node importance from feedback
};

const RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function semanticSimilarity(prompt: string, node: GraphNode): number {
  const promptLower = prompt.toLowerCase();
  const nameLower = node.name.toLowerCase();

  // Exact match in prompt
  if (promptLower.includes(nameLower)) return 1.0;

  // Split PascalCase + kebab/snake into tokens, check partial matches
  const promptTokens = promptLower.split(/\s+/);
  const nameTokens = nameLower
    .split(/(?=[A-Z])|[-_\s]/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 2);

  if (nameTokens.length === 0) return 0;

  const hits = nameTokens.filter((nt) =>
    promptTokens.some((pt) => pt.includes(nt) || nt.includes(pt))
  ).length;

  return hits / nameTokens.length;
}

function normalizeFrequency(freq: number, max: number): number {
  return max > 0 ? Math.min(freq / max, 1.0) : 0;
}

function fileProximity(
  currentFile: string | undefined,
  node: GraphNode
): number {
  if (!currentFile) return 0.5;

  const norm = (p: string) => p.replace(/\\/g, "/");
  const currentDir = norm(currentFile).split("/").slice(0, -1).join("/");
  const nodeDir = norm(node.filePath).split("/").slice(0, -1).join("/");

  if (currentDir === nodeDir) return 1.0;

  const a = currentDir.split("/");
  const b = nodeDir.split("/");
  let shared = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) shared++;
    else break;
  }
  return shared / Math.max(a.length, b.length);
}

function recencyScore(node: GraphNode): number {
  const age = Date.now() - node.lastModified;
  return Math.max(0, 1 - age / RECENCY_WINDOW_MS);
}

export function rankContext(
  prompt: string,
  graph: ContextGraph,
  intent: Intent,
  currentFile?: string,
  topN?: number
): RankedNode[] {
  const nodes = Array.from(graph.nodes.values());
  if (nodes.length === 0) return [];

  const strategy = getStrategy(intent);
  const effectiveTopN = topN ?? strategy.contextTopN;
  const maxFreq = Math.max(...nodes.map((n) => n.callFrequency), 1);

  const scored = nodes.map((node) => {
    const learned = getNodeWeight(node.id); // 0.5 = neutral, grows toward 1 when helpful
    const score =
      semanticSimilarity(prompt, node) * WEIGHTS.semanticSimilarity +
      normalizeFrequency(node.callFrequency, maxFreq) * WEIGHTS.callFrequency +
      fileProximity(currentFile, node) * WEIGHTS.fileProximity +
      recencyScore(node) * WEIGHTS.recency +
      intentMatchScore(node.name, intent) * WEIGHTS.intentMatch +
      learned * WEIGHTS.learnedWeight;

    return { node, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, effectiveTopN).map((item, idx) => ({
    ...item,
    rank: idx + 1,
    role: assignRole(item.node, intent, idx),
  }));
}

function assignRole(node: GraphNode, intent: Intent, rank: number): string {
  const name = node.name.toLowerCase();

  if (rank === 0) {
    if (intent === "debug" || intent === "fix") return "error source";
    if (intent === "explain") return "main entry";
    if (intent === "generate") return "target";
    return "primary";
  }

  if (name.includes("log") || name.includes("logger")) return "logger";
  if (name.includes("auth")) return "auth dependency";
  if (name.includes("error") || name.includes("exception")) return "error handler";
  if (name.includes("config")) return "configuration";
  if (name.includes("middleware") || name.includes("mw")) return "middleware";
  if (name.includes("util") || name.includes("helper")) return "utility";

  return rank === 1 ? "dependency" : "related";
}

export function formatContextForPrompt(
  ranked: RankedNode[],
  intent: Intent
): string {
  if (ranked.length === 0) return "";

  // Always use role labels — scores are internal metrics, not useful to Copilot.
  // Format is designed to be a natural hint for Copilot, not a debug dump.
  const lines = ranked.map((item) => `- ${item.node.name} [${item.role}]`);
  return `[relevant files]\n${lines.join("\n")}`;
}
