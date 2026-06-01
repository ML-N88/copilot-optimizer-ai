// Response Quality Estimator
// Scores either a Copilot response (post-flight) OR an optimized prompt
// (pre-flight) using heuristics.

import { Intent } from "./intent";

export interface QualityScore {
  total: number;            // 0–1
  relevance: number;
  codeDensity: number;
  brevity: number;
  uniqueness: number;
  grade: "excellent" | "good" | "mediocre" | "poor";
  suggestions: string[];
}

export interface PromptScore {
  total: number;
  specificity: number;
  signalToNoise: number;
  hasScope: boolean;
  hasAction: boolean;
  grade: "excellent" | "good" | "mediocre" | "poor";
  suggestions: string[];
}

// ─── Response scoring (post-flight) ──────────────────────────────────────────

function codeRatio(text: string): number {
  const codeBlocks = text.match(/```[\s\S]*?```/g) ?? [];
  const inlineCode = text.match(/`[^`]+`/g) ?? [];
  const codeChars = codeBlocks.reduce((sum, b) => sum + b.length, 0) +
    inlineCode.reduce((sum, c) => sum + c.length, 0);
  return Math.min(codeChars / Math.max(text.length, 1), 1);
}

function brevityScore(text: string): number {
  const words = text.split(/\s+/).length;
  if (words < 20) return 0.3;   // too short — likely unhelpful
  if (words < 100) return 1.0;
  if (words < 300) return 0.8;
  if (words < 600) return 0.5;
  return 0.2;                   // wall of text
}

function uniquenessScore(text: string): number {
  const sentences = text.split(/[.!?\n]+/).filter((s) => s.trim().length > 10);
  if (sentences.length === 0) return 0.5;
  const unique = new Set(sentences.map((s) => s.trim().toLowerCase()));
  return unique.size / sentences.length;
}

function relevanceScore(response: string, originalPrompt: string): number {
  const promptTokens = originalPrompt.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
  if (promptTokens.length === 0) return 0.5;
  const respLower = response.toLowerCase();
  const hits = promptTokens.filter((t) => respLower.includes(t)).length;
  return hits / promptTokens.length;
}

export function scoreResponse(
  response: string,
  originalPrompt: string,
  intent: Intent
): QualityScore {
  const relevance = relevanceScore(response, originalPrompt);
  const codeDensity = codeRatio(response);
  const brevity = brevityScore(response);
  const uniqueness = uniquenessScore(response);

  // Intent-specific weight adjustments
  let weights = { relevance: 0.4, codeDensity: 0.3, brevity: 0.2, uniqueness: 0.1 };

  if (intent === "explain") {
    weights = { relevance: 0.5, codeDensity: 0.1, brevity: 0.25, uniqueness: 0.15 };
  } else if (intent === "debug" || intent === "fix") {
    weights = { relevance: 0.35, codeDensity: 0.4, brevity: 0.15, uniqueness: 0.1 };
  }

  const total =
    relevance * weights.relevance +
    codeDensity * weights.codeDensity +
    brevity * weights.brevity +
    uniqueness * weights.uniqueness;

  const suggestions: string[] = [];
  if (relevance < 0.4) suggestions.push("Response seems off-topic — add more scope context");
  if (codeDensity < 0.1 && (intent === "debug" || intent === "generate")) {
    suggestions.push("No code in response — try structured prompt format");
  }
  if (brevity < 0.4) suggestions.push("Response is very long — add: minimal response");
  if (uniqueness < 0.6) suggestions.push("Response contains repetition — use: no repetition");

  return {
    total,
    relevance,
    codeDensity,
    brevity,
    uniqueness,
    grade: gradeFromScore(total),
    suggestions,
  };
}

// ─── Prompt scoring (pre-flight) ─────────────────────────────────────────────

export function scorePrompt(prompt: string): PromptScore {
  const words = prompt.split(/\s+/);
  const totalWords = words.length;

  // Stop words as noise
  const stopWords = new Set([
    "please", "help", "me", "just", "can", "you", "could", "would",
    "like", "want", "need", "the", "a", "an", "is", "are",
    "really", "very", "basically", "actually",
  ]);
  const noiseCount = words.filter((w) => stopWords.has(w.toLowerCase())).length;
  const signalToNoise = totalWords > 0 ? 1 - noiseCount / totalWords : 0;

  // Specificity: does it contain concrete identifiers?
  const hasScope = /\b[A-Z][a-zA-Z]{2,}\b/.test(prompt) || /\w+\.\w{2,4}/.test(prompt);
  const hasAction = /\b(fix|debug|refactor|explain|generate|write|implement|create|add|review|optimize)\b/i.test(prompt);

  const specificity =
    (hasScope ? 0.5 : 0) +
    (hasAction ? 0.3 : 0) +
    (totalWords >= 3 && totalWords <= 20 ? 0.2 : 0);

  const total = specificity * 0.6 + signalToNoise * 0.4;

  const suggestions: string[] = [];
  if (!hasAction) suggestions.push("Add an action verb (fix, explain, generate…)");
  if (!hasScope) suggestions.push("Specify a target (class, file, function name)");
  if (signalToNoise < 0.6) suggestions.push("Remove filler words (please, just, could you…)");
  if (totalWords > 25) suggestions.push("Prompt is verbose — optimizer will compress it");

  return {
    total,
    specificity,
    signalToNoise,
    hasScope,
    hasAction,
    grade: gradeFromScore(total),
    suggestions,
  };
}

function gradeFromScore(score: number): QualityScore["grade"] {
  if (score >= 0.8) return "excellent";
  if (score >= 0.6) return "good";
  if (score >= 0.4) return "mediocre";
  return "poor";
}
