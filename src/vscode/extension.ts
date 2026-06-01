import * as vscode from "vscode";
import { detectIntent } from "../core/intent";
import { compilePrompt } from "../core/compiler";
import { optimizePrompt } from "../core/optimizer";
import { logFeedback, getStats, getWeightedStrategy, ImplicitSignal, computeTrueQualityScore } from "../core/feedback";
import { buildGraph, getGraph } from "../context/graph";
import { rankContext, formatContextForPrompt } from "../context/ranker";
import { scorePrompt, scoreResponse } from "../core/scorer";
import { applyBudget, getDefaultBudget } from "../core/budget";
import { getStrategy, ReasoningMode } from "../core/strategy";
import { buildCacheKey, lookupStrategyCacheFuzzy, updateStrategyCache } from "../core/strategyCache";
import { createDashboard } from "./ui";

// ─── Release config ───────────────────────────────────────────────────────────
// Flip to `false` during local development to enable 4-variant search + debug.
const RELEASE_MODE = true;
const CONFIG = {
  /** How many orthogonal variants to run during refinement. */
  maxVariants: RELEASE_MODE ? 2 : 4,
  /** Log verbose pipeline details to the output channel. */
  enableDebug: !RELEASE_MODE,
  /** Try a wider-context build when confidence is low. */
  confidenceExpansion: true,
};

let autopilotEnabled = false;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Copilot Optimizer AI");

  // Status bar toggle
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = "$(zap) Optimizer: OFF";
  statusBarItem.tooltip = "Copilot Optimizer AI — click to toggle autopilot";
  statusBarItem.command = "copilot-optimizer.toggleAutopilot";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Build context graph on startup (fire-and-forget)
  buildGraph().then(() => {
    if (CONFIG.enableDebug) outputChannel.appendLine("[Optimizer] Context graph built.");
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilot-optimizer.optimize",
      () => runOptimizer()
    ),
    vscode.commands.registerCommand(
      "copilot-optimizer.toggleAutopilot",
      () => toggleAutopilot()
    ),
    vscode.commands.registerCommand(
      "copilot-optimizer.showFeedback",
      () => showDashboard(context)
    ),
    vscode.commands.registerCommand(
      "copilot-optimizer.rebuildGraph",
      async () => {
        await buildGraph();
        vscode.window.showInformationMessage("Context graph rebuilt.");
      }
    ),
    vscode.commands.registerCommand(
      "copilot-optimizer.scoreResponse",
      () => runResponseScorer()
    ),
    vscode.commands.registerCommand(
      "copilot-optimizer.quickSend",
      () => quickSend()
    )
  );

  if (CONFIG.enableDebug) outputChannel.appendLine("[Optimizer] Copilot Optimizer AI activated.");
}

// ─── Core pipeline ────────────────────────────────────────────────────────────

interface PipelineResult {
  intent: ReturnType<typeof detectIntent>;
  compiled: ReturnType<typeof compilePrompt>;
  optimized: ReturnType<typeof optimizePrompt>;
  withContext: string;
  ranked: ReturnType<typeof rankContext>;
  budgetResult: ReturnType<typeof applyBudget>;
  promptScore: ReturnType<typeof scorePrompt>;
  wasRefined: boolean;
  refinementReason?: string;
  selectedVariant?: string;
  cacheHit: boolean;
  cacheKey: string;
  /** How confident the system is in the selected strategy (based on variant score variance) */
  confidence: "high" | "medium" | "low";
}

interface RefinementVariant {
  label: string;
  /** Dimension 1: compression */
  compressionOverride?: "minimal" | "moderate" | "aggressive";
  /** Dimension 2: context breadth */
  extraContextNodes?: number;
  /** Dimension 3: reasoning approach */
  reasoningOverride?: ReasoningMode;
  /** Dimension 4: output compactness (halves maxLines via dedicated output_shape_variant flag) */
  compactOutput?: boolean;
}

// 4 orthogonal variants — each varies exactly one dimension
// In RELEASE_MODE only the two most impactful variants run (faster, stabler).
const REFINEMENT_VARIANTS: RefinementVariant[] = [
  { label: "compression_variant",   compressionOverride: "minimal" },
  { label: "reasoning_variant",     reasoningOverride: "step-by-step" },
  { label: "context_variant",       extraContextNodes: 3 },
  { label: "output_shape_variant",  compactOutput: true },
];
const ACTIVE_VARIANTS = REFINEMENT_VARIANTS.slice(0, CONFIG.maxVariants);

function buildPipelineCore(
  prompt: string,
  currentFile: string | undefined,
  compressionOverride?: "minimal" | "moderate" | "aggressive",
  contextNodeOffset = 0,
  reasoningOverride?: ReasoningMode,
  compactOutput = false
): Omit<PipelineResult, "wasRefined" | "refinementReason" | "selectedVariant" | "cacheHit" | "cacheKey" | "confidence"> {
  const intent = detectIntent(prompt);
  const compiled = compilePrompt(prompt, intent, reasoningOverride);
  const promptScore = scorePrompt(prompt);

  // Learning: use weighted adaptive strategy when no override given
  const learnedStrategy = compressionOverride ?? getWeightedStrategy(intent.intent);
  const optimized = optimizePrompt(prompt, intent.intent, learnedStrategy);

  const graph = getGraph();
  const ranked = rankContext(
    prompt,
    graph,
    intent.intent,
    currentFile,
    getStrategy(intent.intent).contextTopN + contextNodeOffset
  );
  const contextBlock = formatContextForPrompt(ranked, intent.intent);

  // For debug/fix: the structured prompt IS the output — use it as the base for budget.
  // For all other intents: use the word-compressed text as usual.
  const isStructuredIntent = intent.intent === "debug" || intent.intent === "fix";
  const promptBase = isStructuredIntent ? compiled.structuredPrompt : optimized.optimized;

  const budgetResult = applyBudget(
    promptBase,
    isStructuredIntent ? "" : contextBlock, // structured prompt already contains directives; append context separately below
    ranked,
    intent.intent,
    getDefaultBudget()
  );

  // For structured intents: append the context block after the structured prompt
  const finalPrompt = isStructuredIntent && contextBlock
    ? `${budgetResult.prompt}\n\n${contextBlock}`
    : budgetResult.prompt;

  // For compact output variant: strip the last two directives (format + max_lines) and
  // replace with halved max_lines so the variant really is a different dimension.
  if (compactOutput) {
    const strategy = getStrategy(intent.intent);
    const lines = compiled.structuredPrompt.split("\n");
    const replaced = lines.map((l) =>
      l.startsWith("max_lines:") ? `max_lines: ${Math.max(5, Math.floor(strategy.outputShape.maxLines / 2))}` : l
    );
    (compiled as { structuredPrompt: string }).structuredPrompt = replaced.join("\n");
  }

  return { intent, compiled, optimized, withContext: finalPrompt, ranked, budgetResult, promptScore };
}

function runPipeline(
  prompt: string,
  currentFile?: string,
  forceStrategy?: "minimal" | "moderate" | "aggressive"
): PipelineResult {
  const base = buildPipelineCore(prompt, currentFile, forceStrategy);
  const strategy = getStrategy(base.intent.intent);
  const contextNodeNames = base.ranked.map((r) => r.node.name);
  const cacheKey = buildCacheKey(base.intent.intent, contextNodeNames);

  // Check strategy cache (exact + fuzzy) — skip search when we know the winner
  const cacheMatch = !forceStrategy
    ? lookupStrategyCacheFuzzy(cacheKey, base.intent.intent, contextNodeNames)
    : undefined;

  if (cacheMatch) {
    const cached = buildPipelineCore(prompt, currentFile, cacheMatch.strategy);
    return {
      ...cached,
      wasRefined: false,
      cacheHit: true,
      cacheKey,
      confidence: "high", // cache = known good
    };
  }

  // ── Composite score helper ──────────────────────────────────────────────────
  // Blends budget fitness, compression ratio, and prompt quality into one number
  function compositeScore(
    r: ReturnType<typeof buildPipelineCore>
  ): number {
    const budgetFit = r.budgetResult.finalTokens <= getDefaultBudget() ? 0.5 : 0;
    return budgetFit + r.optimized.compressionRatio * 0.3 + r.promptScore.total * 0.2;
  }

  // ── Multi-strategy orthogonal search ───────────────────────────────────────
  if (!forceStrategy && base.promptScore.total < strategy.autoRetryThreshold) {
    const candidates: Array<{ result: ReturnType<typeof buildPipelineCore>; label: string; score: number }> = [
      { result: base, label: "base", score: compositeScore(base) },
    ];

    for (const variant of ACTIVE_VARIANTS) {
      const r = buildPipelineCore(
        prompt, currentFile,
        variant.compressionOverride,
        variant.extraContextNodes ?? 0,
        variant.reasoningOverride,
        variant.compactOutput ?? false
      );
      candidates.push({ result: r, label: variant.label, score: compositeScore(r) });
    }

    // Confidence = how spread out the scores are
    const scores = candidates.map((c) => c.score);
    const scoreRange = Math.max(...scores) - Math.min(...scores);
    const confidence: PipelineResult["confidence"] =
      scoreRange > 0.2 ? "high" : scoreRange > 0.08 ? "medium" : "low";

    // When confidence is low, try a wider context to break the tie
    if (confidence === "low" && CONFIG.confidenceExpansion) {
      const wider = buildPipelineCore(prompt, currentFile, undefined, 3);
      candidates.push({ result: wider, label: "wider_context", score: compositeScore(wider) });
    }

    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));

    return {
      ...best.result,
      wasRefined: true,
      refinementReason: `Multi-strategy: selected "${best.label}" (range ${scoreRange.toFixed(2)}, conf: ${confidence})`,
      selectedVariant: best.label,
      cacheHit: false,
      cacheKey,
      confidence,
    };
  }

  return { ...base, wasRefined: false, cacheHit: false, cacheKey, confidence: "high" };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * Main optimize flow: type prompt → press Enter → optimized result is copied.
 * No format selection — the engine picks the best output automatically.
 */
async function runOptimizer(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selectionText = editor?.document.getText(editor.selection).trim() ?? "";

  const input = await vscode.window.showInputBox({
    prompt: "Improve your Copilot prompt",
    value: selectionText,
    placeHolder: "e.g. fix null pointer in UserService",
    ignoreFocusOut: true,
  });
  if (!input?.trim()) return;

  _optimizeAndCopy(input.trim(), editor?.document.uri.fsPath);
}

/**
 * Quick Send (Ctrl+Alt+Enter): optimizes selected text or asks for a prompt,
 * then copies the result immediately — zero friction.
 */
async function quickSend(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selectionText = editor?.document.getText(editor.selection).trim() ?? "";

  let prompt: string;
  if (selectionText) {
    prompt = selectionText;
  } else {
    const input = await vscode.window.showInputBox({
      prompt: "Quick Send — optimize & copy for Copilot",
      placeHolder: "e.g. fix null pointer in UserService",
      ignoreFocusOut: true,
    });
    if (!input?.trim()) return;
    prompt = input.trim();
  }

  _optimizeAndCopy(prompt, editor?.document.uri.fsPath);
}

/** Shared: run pipeline → copy withContext → show toast with implicit signal. */
function _optimizeAndCopy(prompt: string, currentFile?: string): void {
  const result = runPipeline(prompt, currentFile);
  const { intent, optimized, promptScore, cacheHit, cacheKey, wasRefined, confidence } = result;

  const grade = ({ excellent: "🟢", good: "🟡", mediocre: "🟠", poor: "🔴" })[promptScore.grade];
  const tag = cacheHit ? " [cached]" : wasRefined ? " [refined]" : "";
  const confNote = confidence === "low" ? " — try rephrasing for best results" : "";

  const contextNodeIds   = result.ranked.map((r) => r.node.id);
  const contextNodeNames = result.ranked.map((r) => r.node.name);

  // Copy first, then open Copilot Chat so the user just pastes (Ctrl+V).
  // Try the GitHub Copilot Chat panel, fall back silently if not available.
  vscode.env.clipboard.writeText(result.withContext).then(() => {
    vscode.commands.executeCommand("workbench.action.chat.open").then(
      () => { /* chat opened — user presses Ctrl+V */ },
      () => { /* Copilot Chat not available, clipboard still has the result */ }
    );
  });

  vscode.window
    .showInformationMessage(
      `${grade} Optimized & copied!${tag} ~${optimized.tokensSaved} tokens saved${confNote}  |  Ctrl+V into Copilot Chat.`,
      "✓ Great answer",
      "✍ Edited it",
      "↩ Regenerated"
    )
    .then((btn) => {
      const signal: ImplicitSignal =
        btn === "✓ Great answer" ? "accepted_without_edit" :
        btn === "✍ Edited it"   ? "accepted_with_edit"    :
        btn === "↩ Regenerated" ? "regenerated"           :
        "ignored";

      const trueScore = computeTrueQualityScore(signal);
      updateStrategyCache(
        cacheKey,
        optimized.strategy as "minimal" | "moderate" | "aggressive",
        trueScore,
        contextNodeNames,
        intent.intent
      );
      logFeedback(
        prompt,
        result.withContext,
        intent.intent,
        optimized.strategy,
        true,
        0,
        optimized.tokensSaved,
        undefined,
        signal,
        contextNodeIds
      );
    });
}

/** Score a Copilot response pasted by the user */
async function runResponseScorer(): Promise<void> {
  const originalPrompt = await vscode.window.showInputBox({
    prompt: "Paste your original prompt (for relevance scoring)",
    ignoreFocusOut: true,
    placeHolder: "fix null pointer in UserService",
  });
  if (!originalPrompt?.trim()) return;

  const response = await vscode.window.showInputBox({
    prompt: "Paste Copilot's response to score",
    ignoreFocusOut: true,
    placeHolder: "Paste the full Copilot response here…",
  });
  if (!response?.trim()) return;

  const intent = detectIntent(originalPrompt);
  const quality = scoreResponse(response, originalPrompt, intent.intent);

  const gradeEmoji = { excellent: "🟢", good: "🟡", mediocre: "🟠", poor: "🔴" };
  const g = gradeEmoji[quality.grade];

  const msg = `${g} Response quality: ${quality.grade.toUpperCase()} (${(quality.total * 100).toFixed(0)}%)` +
    ` — relevance ${(quality.relevance * 100).toFixed(0)}%` +
    ` | code ${(quality.codeDensity * 100).toFixed(0)}%` +
    ` | brevity ${(quality.brevity * 100).toFixed(0)}%`;

  const action = quality.grade === "poor" || quality.grade === "mediocre"
    ? await vscode.window.showWarningMessage(
        msg,
        ...(quality.suggestions.length > 0 ? ["Re-optimize Prompt"] : [])
      )
    : vscode.window.showInformationMessage(msg);

  if (action instanceof Promise) {
    const btn = await action;
    if (btn === "Re-optimize Prompt") {
      // Re-run optimizer with reduced compression
      const reResult = runPipeline(originalPrompt, undefined, "minimal");
      await vscode.env.clipboard.writeText(reResult.withContext);
      vscode.window.showInformationMessage("Re-optimized prompt copied with minimal compression.");
    }
  }
}

function toggleAutopilot(): void {
  autopilotEnabled = !autopilotEnabled;
  statusBarItem.text = autopilotEnabled
    ? "$(zap) Optimizer: ON"
    : "$(zap) Optimizer: OFF";
  statusBarItem.backgroundColor = autopilotEnabled
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  vscode.window.showInformationMessage(
    `Copilot Optimizer Autopilot: ${autopilotEnabled ? "ON" : "OFF"}`
  );
}

function showDashboard(context: vscode.ExtensionContext): void {
  const stats = getStats();
  createDashboard(context, stats);
}
export function deactivate(): void {
  outputChannel?.dispose();
}
