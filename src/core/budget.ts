import { RankedNode } from "../context/ranker";
import { optimizePrompt } from "./optimizer";
import { Intent } from "./intent";

export interface BudgetResult {
  prompt: string;
  droppedNodes: number;
  finalTokens: number;
  underBudget: boolean;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

/**
 * Enforce a hard token cap.
 * Algorithm:
 *  1. If prompt + context is already within budget → return as-is.
 *  2. Drop context nodes from lowest score upward until under budget.
 *  3. If still over budget, escalate compression.
 *  4. Hard truncate as last resort.
 */
export function applyBudget(
  basePrompt: string,
  contextBlock: string,
  rankedNodes: RankedNode[],
  intent: Intent,
  maxTokens = 120
): BudgetResult {
  let combined = contextBlock ? `${basePrompt}\n\n${contextBlock}` : basePrompt;
  let tokens = estimateTokens(combined);
  let droppedNodes = 0;

  if (tokens <= maxTokens) {
    return { prompt: combined, droppedNodes: 0, finalTokens: tokens, underBudget: true };
  }

  // Step 1: drop context nodes from lowest score upward
  const sortedNodes = [...rankedNodes].sort((a, b) => a.score - b.score);
  const activeNodes = [...rankedNodes];

  for (const node of sortedNodes) {
    if (tokens <= maxTokens) break;

    const idx = activeNodes.findIndex((n) => n.node.id === node.node.id);
    if (idx !== -1) {
      activeNodes.splice(idx, 1);
      droppedNodes++;

      // Rebuild context block without the dropped node
      const ctxLines = activeNodes.map((n) => `- ${n.node.name} [${n.role}]`);
      const newContext = activeNodes.length > 0 ? `[relevant files]\n${ctxLines.join("\n")}` : "";
      combined = newContext ? `${basePrompt}\n\n${newContext}` : basePrompt;
      tokens = estimateTokens(combined);
    }
  }

  // Step 2: escalate compression if still over
  if (tokens > maxTokens) {
    const moreCompressed = optimizePrompt(basePrompt, intent, "aggressive");
    const ctx = combined.includes("[relevant files]")
      ? combined.slice(combined.indexOf("[relevant files]"))
      : "";
    combined = ctx ? `${moreCompressed.optimized}\n\n${ctx}` : moreCompressed.optimized;
    tokens = estimateTokens(combined);
  }

  // Step 3: hard truncate as absolute last resort
  if (tokens > maxTokens) {
    const words = combined.split(/\s+/).slice(0, Math.floor(maxTokens / 1.3));
    combined = words.join(" ");
    tokens = estimateTokens(combined);
  }

  return {
    prompt: combined,
    droppedNodes,
    finalTokens: tokens,
    underBudget: tokens <= maxTokens,
  };
}

export function getDefaultBudget(): number {
  return 120;
}
