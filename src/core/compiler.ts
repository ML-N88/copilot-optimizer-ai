import { IntentResult } from "./intent";
import { getStrategy, buildOutputShapeDirectives, buildReasoningDirective, ReasoningMode } from "./strategy";

export interface PromptAST {
  action: string;
  object?: string;
  scope?: string;
  modifiers: string[];
  raw: string;
}

export interface CompilerResult {
  ast: PromptAST;
  compiled: string;         // "action: object scope"
  bytecode: string;         // "intent: fix | obj: null pointer | scope: UserService"
  eliteMode: string;        // "fix npe UserService"
  structuredPrompt: string; // full directive block (bytecode + output constraints)
}

const actionVerbs: Record<string, string> = {
  fix: "fix",
  repair: "fix",
  solve: "fix",
  debug: "dbg",
  refactor: "rfct",
  explain: "xpln",
  describe: "xpln",
  generate: "gen",
  create: "gen",
  write: "gen",
  implement: "impl",
  add: "add",
  optimize: "opt",
  improve: "impr",
  review: "rev",
};

const stopWords = new Set([
  "the", "a", "an", "in", "with", "for", "my", "this", "that", "it",
  "please", "help", "me", "can", "you", "could", "would", "like",
]);

function extractAction(prompt: string): string {
  for (const word of prompt.toLowerCase().split(/\s+/)) {
    if (actionVerbs[word]) return word;
  }
  return "help";
}

function extractObject(prompt: string, action: string): string | undefined {
  const lower = prompt.toLowerCase();
  const idx = lower.indexOf(action);
  if (idx === -1) return undefined;

  const after = prompt.slice(idx + action.length).trim();
  const words = after
    .split(/\s+/)
    .filter((w) => !stopWords.has(w.toLowerCase()))
    .slice(0, 3);

  return words.length > 0 ? words.join(" ") : undefined;
}

function extractScope(prompt: string): string | undefined {
  const pascalMatch = prompt.match(/\b([A-Z][a-zA-Z]{2,})\b/);
  if (pascalMatch) return pascalMatch[1];

  const fileMatch = prompt.match(/\b(\w+\.[a-z]{2,4})\b/);
  if (fileMatch) return fileMatch[1];

  return undefined;
}

function buildBytecode(ast: PromptAST): string {
  const parts: string[] = [
    `intent: ${actionVerbs[ast.action] ?? ast.action}`,
  ];
  if (ast.object) parts.push(`obj: ${ast.object}`);
  if (ast.scope) parts.push(`scope: ${ast.scope}`);
  if (ast.modifiers.length > 0) parts.push(`mod: ${ast.modifiers.join(",")}`);
  return parts.join(" | ");
}

function buildEliteMode(ast: PromptAST): string {
  const action = actionVerbs[ast.action] ?? ast.action;
  const parts = [action];
  if (ast.object) parts.push(ast.object.split(" ").slice(0, 2).join(" "));
  if (ast.scope) parts.push(ast.scope);
  return parts.join(" ");
}

/**
 * Extract debug signal keywords that should be preserved as a `focus:` directive.
 * Catches DI, validation, race conditions, async issues, etc.
 */
function extractFocusKeywords(prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const hits: string[] = [];

  const patterns: [RegExp, string][] = [
    // Catches: "dependency injection", "dependencies are injected", "injected dependencies", "DI"
    [/\bdependenc\w*\s+inject\w*|inject\w*\s+dependenc\w*|\b(di|ioc)\b/i, "dependency injection"],
    [/\bvalidat\w+/i,              "validation"],
    [/\bintermittent\b/i,          "intermittent"],
    [/\brace\s+condition\b/i,      "race condition"],
    [/\basync\b|\bawait\b/i,       "async"],
    // NOTE: null pointer is NOT included here — it's already captured in the debug: line as NPE
    [/\bmemory\s+leak\b/i,         "memory leak"],
    [/\btimeout/i,                 "timeout"],
    [/\bpermission|\bunauthoriz/i, "authorization"],
  ];

  for (const [re, label] of patterns) {
    if (re.test(lower) && !hits.includes(label)) hits.push(label);
  }

  return hits;
}

/**
 * For debug/fix intents: extract the core problem signal and suspected causes
 * from the raw prompt, then return a structured representation:
 *
 *   debug: user creation crash
 *   cause: dependency injection | validation
 *   scope: UserService
 *
 * This is fundamentally different from word-level compression — it restructures
 * the meaning into a form that Copilot understands immediately.
 */
function buildDebugStructure(
  prompt: string,
  intentResult: IntentResult,
  focusKeywords: string[]
): string | null {
  if (intentResult.intent !== "debug" && intentResult.intent !== "fix") return null;

  const lower = prompt.toLowerCase();

  // ── Core problem signal ──────────────────────────────────────────────────
  const problemSignals: string[] = [];

  // ── Scope: require a real technical term, not a greeting or filler word ────
  const SCOPE_IGNORE = new Set(["hey", "hi", "hello", "please", "can", "could", "i", "im", "ok", "so"]);

  // Named scope (PascalCase class / service) — must not be a known greeting
  const scopeMatch = prompt.match(/\b([A-Z][a-zA-Z]{2,}(?:Service|Controller|Manager|Handler|Repository|Util|Helper)?)\b/g)
    ?.find(w => !SCOPE_IGNORE.has(w.toLowerCase()));

  // Fallback: infer domain entity from common keywords
  let scope: string | undefined = scopeMatch ?? intentResult.target;
  if (!scope || SCOPE_IGNORE.has(scope.toLowerCase())) {
    if (/\buser\b/i.test(prompt))        scope = "UserService";
    else if (/\bauth\b/i.test(prompt))   scope = "AuthService";
    else if (/\border\b/i.test(prompt))  scope = "OrderService";
    else if (/\bpayment\b/i.test(prompt)) scope = "PaymentService";
    else scope = undefined;
  }

  // Action signals
  if (/\bcreate\s+user|\buser\s+creat/i.test(prompt))    problemSignals.push("user creation");
  else if (/\blogin|\bsign\s*in/i.test(prompt))           problemSignals.push("login");
  else if (/\bsave|\bpersist/i.test(prompt))              problemSignals.push("save");
  else if (/\bload|\bfetch|\bget/i.test(prompt))         problemSignals.push("data fetch");
  else if (/\bdelete|\bremov/i.test(prompt))             problemSignals.push("delete");
  else if (/\bstart|\binit/i.test(prompt))               problemSignals.push("initialization");

  // Error type signals
  if (/\bnull\s*pointer|\bnpe/i.test(lower))             problemSignals.push("NPE");
  else if (/\bcrash\b/i.test(lower))                     problemSignals.push("crash");
  else if (/\bexception\b/i.test(lower))                 problemSignals.push("exception");
  else if (/\bundefined\b/i.test(lower))                 problemSignals.push("undefined");
  else if (/\btimeout/i.test(lower))                     problemSignals.push("timeout");

  if (/\bintermittent\b|\bsometimes\b|\bnot\s+always\b/i.test(lower)) problemSignals.push("intermittent");

  // Must have at least one signal to produce structured output
  if (problemSignals.length === 0 && focusKeywords.length === 0) return null;

  // Enrich cause: if only one cause keyword and NPE was detected, add null reference
  // so Copilot investigates both the symptom AND the structural cause.
  const enrichedCause = [...focusKeywords];
  if (problemSignals.includes("NPE") && enrichedCause.length === 1 && !enrichedCause.includes("null reference")) {
    enrichedCause.push("null reference");
  }

  // Hint: give Copilot a concrete first-check directive based on the error type
  let hint: string | null = null;
  if (problemSignals.includes("NPE")) {
    hint = "hint: check null before access, verify DI init order";
  } else if (problemSignals.includes("timeout")) {
    hint = "hint: check connection pool, slow query, external call";
  } else if (problemSignals.includes("undefined")) {
    hint = "hint: check object initialization and optional chaining";
  }

  const problemLine = `${intentResult.intent}: ${problemSignals.join(" ")}`;
  const causeLine   = enrichedCause.length > 0 ? `cause: ${enrichedCause.join(" | ")}` : null;
  const scopeLine   = scope ? `scope: ${scope}` : null;

  return [problemLine, causeLine, scopeLine, hint].filter(Boolean).join("\n");
}

export function compilePrompt(
  prompt: string,
  intentResult: IntentResult,
  reasoningOverride?: ReasoningMode
): CompilerResult {
  const action = extractAction(prompt);
  const object = extractObject(prompt, action);
  const scope = intentResult.target ?? extractScope(prompt);

  const modifiers: string[] = [];
  if (/\bquick(ly)?\b/i.test(prompt)) modifiers.push("quick");
  if (/\bdetail(ed)?\b/i.test(prompt)) modifiers.push("detailed");
  if (/\bsimple\b/i.test(prompt)) modifiers.push("simple");

  const ast: PromptAST = { action, object, scope, modifiers, raw: prompt };

  const compiledParts = [`${action}:`];
  if (object) compiledParts.push(object);
  if (scope && scope !== object) compiledParts.push(scope);
  const compiledHeader = compiledParts.join(" ");

  const focusKeywords = extractFocusKeywords(prompt);

  // For debug/fix: replace freeform text with a structured intent representation.
  // This gives Copilot a signal-dense directive instead of compressed natural language.
  const debugStructure = buildDebugStructure(prompt, intentResult, focusKeywords);

  const strategy = getStrategy(intentResult.intent);
  const outputShapeDirectives = buildOutputShapeDirectives(intentResult.intent);

  // Structured prompt: debug/fix uses the rewritten header; others use compiled action.
  // Then constraints, consolidated output line, reasoning approach.
  const promptHeader = debugStructure ?? compiledHeader;

  // Consolidate format + max_lines + minimal into one output: line for debug/fix
  let outputLines: string[];
  if (debugStructure) {
    const shape = strategy.outputShape;
    outputLines = [`output: ${shape.format} | max ${shape.maxLines} lines | minimal`];
  } else {
    outputLines = buildOutputShapeDirectives(intentResult.intent);
  }

  const structuredLines: string[] = [
    promptHeader,
    ...(!debugStructure && focusKeywords.length > 0 ? [`focus: ${focusKeywords.join(" ")}`] : []),
    ...strategy.outputConstraints,
    ...outputLines,
    buildReasoningDirective(intentResult.intent, reasoningOverride),
  ];
  const structuredPrompt = structuredLines.join("\n");

  return {
    ast,
    compiled: compiledHeader,
    bytecode: buildBytecode(ast),
    eliteMode: buildEliteMode(ast),
    structuredPrompt,
  };
}
