import * as vscode from "vscode";
import {
  runPipeline,
  isOptimizerEnabled,
  showDashboard,
  PipelineResult,
} from "./extension";
import { scoreResponse } from "../core/scorer";
import {
  logFeedback,
  computeTrueQualityScore,
  ImplicitSignal,
} from "../core/feedback";
import { updateStrategyCache } from "../core/strategyCache";

const PARTICIPANT_ID = "copilot-optimizer.chat";
const FEEDBACK_COMMAND = "copilot-optimizer.chatFeedback";

/** How strongly the automatic response score influences learning, relative to
 *  an explicit user click. 0 = ignore auto-score, 1 = treat it like a click.
 *  Kept < 1 so a real button press always carries more weight. */
const SOFT_SCORE_WEIGHT = 0.5;

/** Slash commands that force a particular intent by prefixing the prompt. */
const INTENT_COMMANDS = new Set([
  "debug",
  "fix",
  "refactor",
  "explain",
  "generate",
]);

const GRADE_EMOJI: Record<string, string> = {
  excellent: "🟢",
  good: "🟡",
  mediocre: "🟠",
  poor: "🔴",
};

/** Arguments passed to the feedback command from the in-chat buttons. */
interface FeedbackArgs {
  signal: ImplicitSignal;
  prompt: string;
  withContext: string;
  intent: string;
  strategy: string;
  cacheKey: string;
  contextNodeNames: string[];
  contextNodeIds: string[];
  tokensSaved: number;
}

/**
 * Register the `@optimizer` chat participant plus the command its feedback
 * buttons invoke. This is the native Copilot Chat integration: the user writes
 * naturally, the pipeline rewrites the prompt, the real model answers, and the
 * actual response is scored automatically to close the learning loop.
 */
export function registerChatParticipant(context: vscode.ExtensionContext): void {
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    (request, chatContext, stream, token) =>
      handleChat(request, chatContext, stream, token, context)
  );

  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "images",
    "icon.png"
  );

  participant.followupProvider = {
    provideFollowups(result) {
      const followups: vscode.ChatFollowup[] = [];
      const meta = (result as vscode.ChatResult).metadata as
        | { lowConfidence?: boolean; lastPrompt?: string }
        | undefined;
      if (meta?.lowConfidence && meta.lastPrompt) {
        followups.push({
          prompt: meta.lastPrompt,
          label: "Re-run with minimal compression",
          command: "explain",
        });
      }
      followups.push({
        prompt: "Open the optimizer dashboard",
        label: "📊 Show dashboard",
        command: "dashboard",
      });
      return followups;
    },
  };

  context.subscriptions.push(participant);

  // Command invoked by the in-chat feedback buttons.
  context.subscriptions.push(
    vscode.commands.registerCommand(FEEDBACK_COMMAND, (args: FeedbackArgs) => {
      const trueScore = computeTrueQualityScore(args.signal);
      updateStrategyCache(
        args.cacheKey,
        args.strategy as "minimal" | "moderate" | "aggressive",
        trueScore,
        args.contextNodeNames,
        args.intent,
        true // authoritative — an explicit click overrides the soft auto-score
      );
      logFeedback(
        args.prompt,
        args.withContext,
        args.intent,
        args.strategy,
        args.signal === "accepted_without_edit" ||
          args.signal === "accepted_with_edit",
        0,
        args.tokensSaved,
        undefined,
        args.signal,
        args.contextNodeIds
      );
      vscode.window.setStatusBarMessage(
        "Copilot Optimizer: feedback recorded — thanks!",
        3000
      );
    })
  );
}

async function handleChat(
  request: vscode.ChatRequest,
  _chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  extensionContext: vscode.ExtensionContext
): Promise<vscode.ChatResult> {
  const command = request.command;

  // ── /dashboard — open the existing webview ────────────────────────────────
  if (command === "dashboard") {
    showDashboard(extensionContext);
    stream.markdown("📊 Opened the **Copilot Optimizer** dashboard.");
    return {};
  }

  const userText = request.prompt.trim();
  if (!userText) {
    stream.markdown(
      "Tell me what you need — e.g. `@optimizer fix null pointer in UserService`."
    );
    return {};
  }

  // ── Decide whether to optimize ────────────────────────────────────────────
  const optimizationOn = command !== "raw" && isOptimizerEnabled();

  let promptToSend = userText;
  let result: PipelineResult | undefined;
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;

  if (optimizationOn) {
    // Force an intent for the intent slash-commands by prefixing the prompt.
    const seeded =
      command && INTENT_COMMANDS.has(command)
        ? `${command} ${userText}`
        : userText;

    result = runPipeline(seeded, activeFile);
    promptToSend = result.withContext;

    // Attach REAL file contents (not just names) so the model can actually
    // see the code. Emits clickable references too.
    const fileContext = await buildFileContext(result, stream);
    if (fileContext) promptToSend = `${fileContext}\n\n${promptToSend}`;

    renderOptimizationPreview(stream, result);
  } else {
    const reason = command === "raw" ? "/raw" : "optimization is OFF";
    stream.markdown(
      `> ⏭️ Sending your prompt unchanged (${reason}).\n\n`
    );
  }

  // ── Pick a model ──────────────────────────────────────────────────────────
  // Preference order: a user-configured family → the model the user picked in
  // the chat dropdown (request.model) → the first available Copilot model.
  let model = request.model;
  const preferredFamily = vscode.workspace
    .getConfiguration("copilotOptimizer")
    .get<string>("model", "")
    .trim();

  if (preferredFamily) {
    const matches = await vscode.lm.selectChatModels({
      vendor: "copilot",
      family: preferredFamily,
    });
    if (matches.length > 0) model = matches[0];
  }

  if (!model) {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    model = models[0];
  }

  if (!model) {
    // Graceful fallback: no entitled model — copy the optimized prompt instead.
    await vscode.env.clipboard.writeText(promptToSend);
    stream.markdown(
      "\n⚠️ No language model is available. The optimized prompt has been " +
        "**copied to your clipboard** — paste it into Copilot Chat with `Ctrl+V`."
    );
    return {};
  }

  // ── Send to the real model and stream the answer ──────────────────────────
  let answer = "";
  try {
    const messages = [vscode.LanguageModelChatMessage.User(promptToSend)];
    const response = await model.sendRequest(messages, {}, token);
    for await (const fragment of response.text) {
      answer += fragment;
      stream.markdown(fragment);
    }
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      stream.markdown(`\n\n⚠️ Model error: ${err.message}`);
    } else {
      stream.markdown(
        "\n\n⚠️ Something went wrong while contacting the model."
      );
    }
    return {};
  }

  if (token.isCancellationRequested) return {};

  // ── Auto-score the real response and close the learning loop ───────────────
  if (result && answer.trim()) {
    const intent = result.intent.intent;
    const quality = scoreResponse(answer, userText, intent);

    // Soft (zero-click) signal: dampen the heuristic auto-score toward neutral so
    // it nudges learning but never locks in a value a human click can't correct.
    // An explicit button click (authoritative) always overrides this.
    const softScore = 0.5 + (quality.total - 0.5) * SOFT_SCORE_WEIGHT;
    updateStrategyCache(
      result.cacheKey,
      result.optimized.strategy as "minimal" | "moderate" | "aggressive",
      softScore,
      result.ranked.map((r) => r.node.name),
      intent,
      false // soft — not authoritative
    );

    const g = GRADE_EMOJI[quality.grade] ?? "⚪";
    stream.markdown(
      `\n\n---\n${g} **Response quality: ${quality.grade.toUpperCase()}** ` +
        `(${(quality.total * 100).toFixed(0)}%) — ` +
        `relevance ${(quality.relevance * 100).toFixed(0)}% · ` +
        `code ${(quality.codeDensity * 100).toFixed(0)}% · ` +
        `brevity ${(quality.brevity * 100).toFixed(0)}%`
    );

    renderFeedbackButtons(stream, result, userText);

    return {
      metadata: {
        lowConfidence: result.confidence === "low",
        lastPrompt: userText,
      },
    };
  }

  return {};
}

/** Map a file extension to a Markdown code-fence language hint. */
function fenceLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx",
    py: "python", cs: "csharp", java: "java",
    json: "json", md: "markdown",
  };
  return map[ext] ?? "";
}

/**
 * Read the actual contents of the top-ranked context files and format them as
 * fenced code blocks the model can read. Bounded by a configurable character
 * budget so we never flood the model. Also emits clickable chat references.
 */
async function buildFileContext(
  result: PipelineResult,
  stream: vscode.ChatResponseStream
): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("copilotOptimizer");
  const maxFiles = cfg.get<number>("contextFiles", 3);
  const charBudget = cfg.get<number>("contextCharBudget", 6000);
  if (maxFiles <= 0 || charBudget <= 0) return "";

  const blocks: string[] = [];
  let used = 0;

  for (const ranked of result.ranked.slice(0, maxFiles)) {
    const filePath = ranked.node.filePath;
    if (!filePath) continue;

    const uri = vscode.Uri.file(filePath);
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = Buffer.from(bytes).toString("utf-8");
    } catch {
      continue; // file unreadable — skip
    }

    // Per-file slice so one huge file can't eat the whole budget.
    const perFile = Math.max(800, Math.floor(charBudget / maxFiles));
    let snippet = text.slice(0, perFile);
    if (text.length > perFile) snippet += "\n… (truncated)";

    if (used + snippet.length > charBudget) break;
    used += snippet.length;

    // Clickable reference in the chat UI.
    stream.reference(uri);

    const rel = vscode.workspace.asRelativePath(uri);
    blocks.push(`File: ${rel}\n\`\`\`${fenceLang(filePath)}\n${snippet}\n\`\`\``);
  }

  return blocks.length ? `[workspace context]\n${blocks.join("\n\n")}` : "";
}

/** Render a compact, transparent summary of what the optimizer did. */
function renderOptimizationPreview(
  stream: vscode.ChatResponseStream,
  result: PipelineResult
): void {
  const { intent, optimized, promptScore, confidence, cacheHit, wasRefined } =
    result;
  const grade = GRADE_EMOJI[promptScore.grade] ?? "⚪";
  const tag = cacheHit ? " · cached" : wasRefined ? " · refined" : "";

  stream.markdown(
    `> ${grade} **Optimized** \`${intent.intent}\` prompt — ` +
      `~${optimized.tokensSaved} tokens saved · ` +
      `strategy \`${optimized.strategy}\` · ` +
      `confidence \`${confidence}\`${tag}\n>\n`
  );

  // Show the files injected as context, as proper references.
  for (const r of result.ranked) {
    stream.markdown(`> 📎 \`${r.node.name}\` _(${r.role})_\n`);
  }
  stream.markdown("\n");

  if (confidence === "low") {
    stream.markdown(
      "> ℹ️ Low confidence — rephrasing with more detail may improve results.\n\n"
    );
  }
}

/** Render the implicit-feedback buttons that refine learning. */
function renderFeedbackButtons(
  stream: vscode.ChatResponseStream,
  result: PipelineResult,
  prompt: string
): void {
  const base: Omit<FeedbackArgs, "signal"> = {
    prompt,
    withContext: result.withContext,
    intent: result.intent.intent,
    strategy: result.optimized.strategy,
    cacheKey: result.cacheKey,
    contextNodeNames: result.ranked.map((r) => r.node.name),
    contextNodeIds: result.ranked.map((r) => r.node.id),
    tokensSaved: result.optimized.tokensSaved,
  };

  stream.button({
    command: FEEDBACK_COMMAND,
    title: "✓ Great answer",
    arguments: [{ ...base, signal: "accepted_without_edit" } as FeedbackArgs],
  });
  stream.button({
    command: FEEDBACK_COMMAND,
    title: "✍ Edited it",
    arguments: [{ ...base, signal: "accepted_with_edit" } as FeedbackArgs],
  });
  stream.button({
    command: FEEDBACK_COMMAND,
    title: "↩ Regenerated",
    arguments: [{ ...base, signal: "regenerated" } as FeedbackArgs],
  });
}
