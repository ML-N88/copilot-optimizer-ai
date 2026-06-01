import * as path from "path";
import * as fs from "fs";
import { Intent, getCompressionStrategy } from "./intent";

interface Dictionary {
  abbreviations: Record<string, string>;
  stopwords: string[];
  synonyms: Record<string, string>;
}

export interface OptimizationResult {
  original: string;
  optimized: string;
  tokensSaved: number;
  compressionRatio: number;
  strategy: "minimal" | "moderate" | "aggressive";
}

let dictionary: Dictionary | null = null;

function getDictionaryPath(): string {
  return path.join(__dirname, "..", "..", "data", "dictionary.json");
}

function loadDictionary(): Dictionary {
  if (dictionary) return dictionary;
  try {
    dictionary = JSON.parse(
      fs.readFileSync(getDictionaryPath(), "utf-8")
    ) as Dictionary;
    return dictionary;
  } catch {
    dictionary = { abbreviations: {}, stopwords: [], synonyms: {} };
    return dictionary;
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

function removeFillerPhrases(text: string): string {
  const fillers = [
    /\bplease\s+help\s+me\b/gi,
    /\bcould\s+you\s+please\b/gi,
    /\bi\s+need\s+you\s+to\b/gi,
    /\bcan\s+you\b/gi,
    /\bi\s+would\s+like\s+you\s+to\b/gi,
    /\bif\s+possible\b/gi,
    /\bjust\b/gi,
    /\bactually\b/gi,
    /\bbasically\b/gi,
  ];
  let result = text;
  for (const filler of fillers) {
    result = result.replace(filler, "").trim();
  }
  return result.replace(/\s{2,}/g, " ").trim();
}

function applySynonyms(text: string, dict: Dictionary): string {
  let result = text;
  for (const [verbose, concise] of Object.entries(dict.synonyms)) {
    result = result.replace(new RegExp(`\\b${verbose}\\b`, "gi"), concise);
  }
  return result;
}

function applyAbbreviations(text: string, dict: Dictionary): string {
  let result = text;
  for (const [full, abbr] of Object.entries(dict.abbreviations)) {
    result = result.replace(new RegExp(`\\b${full}\\b`, "gi"), abbr);
  }
  return result;
}

function removeStopwords(text: string, dict: Dictionary): string {
  return text
    .split(/\s+/)
    .filter((w) => !dict.stopwords.includes(w.toLowerCase()))
    .join(" ");
}

export function optimizePrompt(
  prompt: string,
  intent: Intent,
  overrideStrategy?: "minimal" | "moderate" | "aggressive"
): OptimizationResult {
  const dict = loadDictionary();

  // debug and fix always use aggressive compression — the compiler rewrites them
  // into structured form, so we want max noise removal on the raw text first.
  const strategy = overrideStrategy ?? (
    (intent === "debug" || intent === "fix") ? "aggressive" : getCompressionStrategy(intent)
  );

  let optimized = prompt;

  // All strategies: remove filler + apply synonyms
  optimized = removeFillerPhrases(optimized);
  optimized = applySynonyms(optimized, dict);
  optimized = applyAbbreviations(optimized, dict);

  // Moderate + aggressive: strip stopwords
  if (strategy === "moderate" || strategy === "aggressive") {
    optimized = removeStopwords(optimized, dict);
  }

  // Aggressive: strip soft punctuation, collapse whitespace
  if (strategy === "aggressive") {
    optimized = optimized.replace(/[,;!?]/g, "");
    optimized = optimized.replace(/\s+/g, " ").trim();
  }

  const originalTokens = estimateTokens(prompt);
  const optimizedTokens = estimateTokens(optimized);
  const tokensSaved = Math.max(0, originalTokens - optimizedTokens);

  return {
    original: prompt,
    optimized,
    tokensSaved,
    compressionRatio: originalTokens > 0 ? tokensSaved / originalTokens : 0,
    strategy,
  };
}
