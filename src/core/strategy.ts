import { Intent } from "./intent";

export type CompressionLevel = "low" | "medium" | "high";
export type ContextDepth = "high" | "medium" | "low";
export type OutputFormat = "code-first" | "code" | "text" | "mixed";
export type OutputShapeFormat = "code" | "bullet points" | "steps" | "minimal" | "prose";
export type ReasoningMode = "step-by-step" | "direct" | "hypothesis+verify" | "trace";

export interface OutputShape {
  format: OutputShapeFormat;
  maxLines: number;
}

export interface IntentStrategy {
  compression: CompressionLevel;
  contextDepth: ContextDepth;
  outputFormat: OutputFormat;
  contextTopN: number;
  /** Directives appended to the final structured prompt */
  outputConstraints: string[];
  /** Controls the structure and length of the model's response */
  outputShape: OutputShape;
  /** Controls HOW the model reasons through the problem */
  reasoningMode: ReasoningMode;
  /** Intent-relevant node types to prioritise in graph ranking */
  prioritiseNodeTypes: string[];
  autoRetryThreshold: number; // score < this → trigger auto-refinement
}

export const intentStrategies: Record<Intent, IntentStrategy> = {
  debug: {
    compression: "low",
    contextDepth: "high",
    outputFormat: "code-first",
    contextTopN: 3,
    outputConstraints: ["mode: debug", "priority: correctness"],
    outputShape: { format: "code", maxLines: 20 },
    reasoningMode: "trace",
    prioritiseNodeTypes: ["error", "logger", "handler", "middleware"],
    autoRetryThreshold: 0.55,
  },
  fix: {
    compression: "low",
    contextDepth: "high",
    outputFormat: "code-first",
    contextTopN: 3,
    outputConstraints: ["mode: fix", "priority: correctness"],
    outputShape: { format: "code", maxLines: 15 },
    reasoningMode: "step-by-step",
    prioritiseNodeTypes: ["service", "handler", "validator"],
    autoRetryThreshold: 0.55,
  },
  refactor: {
    compression: "medium",
    contextDepth: "medium",
    outputFormat: "code",
    contextTopN: 3,
    outputConstraints: ["mode: refactor", "preserve: behavior", "no repetition"],
    outputShape: { format: "code", maxLines: 30 },
    reasoningMode: "direct",
    prioritiseNodeTypes: ["class", "module", "service"],
    autoRetryThreshold: 0.5,
  },
  explain: {
    compression: "medium",
    contextDepth: "medium",
    outputFormat: "text",
    contextTopN: 3,
    outputConstraints: ["mode: explain", "limit explanation to essential details"],
    outputShape: { format: "bullet points", maxLines: 8 },
    reasoningMode: "step-by-step",
    prioritiseNodeTypes: ["module", "file", "class"],
    autoRetryThreshold: 0.5,
  },
  generate: {
    compression: "high",
    contextDepth: "low",
    outputFormat: "code",
    contextTopN: 2,
    outputConstraints: ["mode: generate", "structure first", "no explanation"],
    outputShape: { format: "code", maxLines: 40 },
    reasoningMode: "direct",
    prioritiseNodeTypes: ["interface", "model", "api"],
    autoRetryThreshold: 0.45,
  },
  general: {
    compression: "medium",
    contextDepth: "medium",
    outputFormat: "mixed",
    contextTopN: 3,
    outputConstraints: ["minimal response"],
    outputShape: { format: "minimal", maxLines: 10 },
    reasoningMode: "direct",
    prioritiseNodeTypes: [],
    autoRetryThreshold: 0.5,
  },
};

export function getStrategy(intent: Intent): IntentStrategy {
  return intentStrategies[intent];
}

/** Build the output-shape directive lines to append to a structured prompt */
export function buildOutputShapeDirectives(intent: Intent): string[] {
  const shape = intentStrategies[intent].outputShape;
  return [
    `format: ${shape.format}`,
    `max_lines: ${shape.maxLines}`,
  ];
}

/** Build the approach/reasoning directive to append to a structured prompt */
export function buildReasoningDirective(intent: Intent, override?: ReasoningMode): string {
  const mode = override ?? intentStrategies[intent].reasoningMode;
  return `approach: ${mode}`;
}

/** Check if a node name/type is relevant for the given intent */
export function intentMatchScore(
  nodeName: string,
  intent: Intent
): number {
  const strategy = getStrategy(intent);
  if (strategy.prioritiseNodeTypes.length === 0) return 0.5;

  const nameLower = nodeName.toLowerCase();
  for (const keyword of strategy.prioritiseNodeTypes) {
    if (nameLower.includes(keyword)) return 1.0;
  }

  // Partial: check if any keyword token is in the name
  const nameTokens = nameLower.split(/(?=[A-Z])|[-_\s]/).map((t) => t.toLowerCase());
  for (const keyword of strategy.prioritiseNodeTypes) {
    if (nameTokens.some((t) => t === keyword || keyword.includes(t))) return 0.6;
  }

  return 0.0;
}
