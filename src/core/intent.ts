export type Intent =
  | "debug"
  | "refactor"
  | "explain"
  | "generate"
  | "fix"
  | "general";

export interface IntentResult {
  intent: Intent;
  target?: string;
  detail?: string;
  confidence: number;
}

interface PatternGroup {
  patterns: RegExp[];
}

const intentPatterns: Record<Exclude<Intent, "general">, PatternGroup> = {
  debug: {
    patterns: [
      /\berror\b/i,
      /\bexception\b/i,
      /\bbug\b/i,
      /\bcrash\b/i,
      /\bnull\s*pointer\b/i,
      /\bnpe\b/i,
      /\bundefined\b/i,
      /\bfails?\b/i,
      /\bbroken\b/i,
    ],
  },
  fix: {
    patterns: [
      /\bfix\b/i,
      /\bsolve\b/i,
      /\bresolve\b/i,
      /\brepair\b/i,
      /\bcorrect\b/i,
    ],
  },
  refactor: {
    patterns: [
      /\brefactor\b/i,
      /\bclean\b/i,
      /\brewrite\b/i,
      /\bimprove\b/i,
      /\bsimplify\b/i,
      /\brestructure\b/i,
    ],
  },
  explain: {
    patterns: [
      /\bexplain\b/i,
      /\bwhat\s+is\b/i,
      /\bhow\s+does\b/i,
      /\bunderstand\b/i,
      /\bdescribe\b/i,
      /\bwhy\b/i,
    ],
  },
  generate: {
    patterns: [
      /\bwrite\b/i,
      /\bcreate\b/i,
      /\bgenerate\b/i,
      /\badd\b/i,
      /\bimplement\b/i,
      /\bbuild\b/i,
      /\bfunction\b/i,
      /\bclass\b/i,
    ],
  },
};

function extractTarget(prompt: string): string | undefined {
  // PascalCase service/class names
  const pascalMatch = prompt.match(
    /\b([A-Z][a-zA-Z]+(Service|Controller|Manager|Handler|Repository|Helper|Util|Model|Component)?)\b/
  );
  if (pascalMatch) return pascalMatch[1];

  // File references
  const fileMatch = prompt.match(/\b(\w+\.[a-z]{2,4})\b/);
  if (fileMatch) return fileMatch[1];

  return undefined;
}

function extractDetail(
  prompt: string,
  intent: Intent
): string | undefined {
  if (intent === "debug" || intent === "fix") {
    const errorMatch = prompt.match(
      /(?:null pointer|npe|undefined|exception|error)[:\s]+([^.!?\n]+)/i
    );
    if (errorMatch) return errorMatch[1].trim();
  }
  return undefined;
}

export function detectIntent(prompt: string): IntentResult {
  const scores: Partial<Record<Exclude<Intent, "general">, number>> = {};

  for (const [key, group] of Object.entries(intentPatterns) as [
    Exclude<Intent, "general">,
    PatternGroup
  ][]) {
    let matches = 0;
    for (const pattern of group.patterns) {
      if (pattern.test(prompt)) matches++;
    }
    if (matches > 0) {
      scores[key] = matches / group.patterns.length;
    }
  }

  let bestIntent: Intent = "general";
  let bestScore = 0;

  for (const [intent, score] of Object.entries(scores) as [
    Exclude<Intent, "general">,
    number
  ][]) {
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  return {
    intent: bestIntent,
    target: extractTarget(prompt),
    detail: extractDetail(prompt, bestIntent),
    confidence: bestScore,
  };
}

export function getCompressionStrategy(
  intent: Intent
): "minimal" | "moderate" | "aggressive" {
  switch (intent) {
    case "debug":
    case "fix":
      return "minimal"; // preserve nuance
    case "explain":
    case "refactor":
      return "moderate";
    case "generate":
      return "aggressive"; // structure first
    default:
      return "moderate";
  }
}
