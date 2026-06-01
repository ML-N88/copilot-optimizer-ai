import * as vscode from "vscode";
import { FeedbackStats } from "../core/feedback";
import { intentStrategies } from "../core/strategy";
import { getCacheStats } from "../core/strategyCache";
import { getTopNodes } from "../context/nodeWeights";

export function createDashboard(
  context: vscode.ExtensionContext,
  stats: FeedbackStats
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "copilotOptimizerDashboard",
    "Copilot Optimizer v2",
    vscode.ViewColumn.One,
    { enableScripts: false, retainContextWhenHidden: true }
  );

  panel.webview.html = buildHtml(stats, getCacheStats(), getTopNodes(10));
  return panel;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function buildHtml(
  stats: FeedbackStats,
  cacheStats: ReturnType<typeof getCacheStats>,
  topNodes: ReturnType<typeof getTopNodes>
): string {
  const intentRows = Object.entries(stats.byIntent)
    .map(
      ([intent, data]) => `
        <tr>
          <td>${intent}</td>
          <td>${data.count}</td>
          <td>${pct(data.acceptRate)}</td>
          <td>${data.avgTokensSaved.toFixed(1)}</td>
        </tr>`
    )
    .join("");

  // Strategy table from live intentStrategies config
  const strategyRows = Object.entries(intentStrategies)
    .map(
      ([intent, s]) => `
        <tr>
          <td><strong>${intent}</strong></td>
          <td>${s.compression}</td>
          <td>${s.contextDepth}</td>
          <td>${s.outputFormat}</td>
          <td>${s.contextTopN}</td>
          <td><code style="font-size:0.75rem">${s.outputConstraints.join(", ")}</code></td>
          <td>${s.outputShape.format} / ${s.outputShape.maxLines} lines</td>
          <td><span class="strat-badge">${s.reasoningMode}</span></td>
        </tr>`
    )
    .join("");

  const compTable = `
    <table>
      <thead>
        <tr>
          <th>Feature</th>
          <th>v1</th>
          <th>v2</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>Compression</td><td>✅</td><td>✅</td></tr>
        <tr><td>Guardrails</td><td>✅</td><td>✅</td></tr>
        <tr><td>Context Graph</td><td>✅</td><td>✅ (ranked + intent_match)</td></tr>
        <tr><td>Intent Awareness</td><td>❌</td><td>✅</td></tr>
        <tr><td>Strategy Mapping</td><td>❌</td><td>✅</td></tr>
        <tr><td>Prompt Scorer</td><td>❌</td><td>✅</td></tr>
        <tr><td>Response Scorer</td><td>❌</td><td>✅</td></tr>
        <tr><td>Multi-strategy Refinement</td><td>❌</td><td>✅ (3 variants)</td></tr>
        <tr><td>Token Budget Controller</td><td>❌</td><td>✅ (120 token cap)</td></tr>
        <tr><td>Output Shaping</td><td>❌</td><td>✅ (format + max_lines)</td></tr>
        <tr><td>Anti-fluff Constraints</td><td>❌</td><td>✅</td></tr>
        <tr><td>Feedback Loop</td><td>❌</td><td>✅</td></tr>
        <tr><td>Learning Feedback Weights</td><td>❌</td><td>✅ (success_rate * 0.7)</td></tr>
        <tr><td>Orthogonal Strategy Engine</td><td>❌</td><td>✅ v4 (4 dimensions)</td></tr>
        <tr><td>Reasoning Mode Control</td><td>❌</td><td>✅ v4 (approach: trace / step-by-step / direct)</td></tr>
        <tr><td>Implicit Feedback Scoring</td><td>❌</td><td>✅ v4 (true quality score)</td></tr>
        <tr><td>Strategy Memory Cache</td><td>❌</td><td>✅ v5 (hash-keyed, cache hits)</td></tr>
        <tr><td>Adaptive Context Graph</td><td>❌</td><td>✅ v5 (node weight learning)</td></tr>
        <tr><td>Fuzzy Cache Matching</td><td>❌</td><td>✅ v6 (Jaccard ≥ 0.8)</td></tr>
        <tr><td>Node Weight Decay</td><td>❌</td><td>✅ v6 (half-life 30d)</td></tr>
        <tr><td>Confidence Scoring</td><td>❌</td><td>✅ v6 (score-range variance)</td></tr>
      </tbody>
    </table>`;

  const noData = stats.totalEntries === 0;

  // True quality stats from implicit signals
  const signalDist = stats.signalDistribution ?? {};
  const signalTotal = Object.values(signalDist).reduce((a, b) => a + (b ?? 0), 0);
  const trueQualitySection = signalTotal === 0
    ? `<p class="empty">No implicit signals yet — use an optimized prompt and click a reaction button.</p>`
    : `<table>
        <thead><tr><th>Signal</th><th>Count</th><th>%</th></tr></thead>
        <tbody>
          ${
            (["accepted_without_edit", "accepted_with_edit", "regenerated", "ignored"] as const)
              .map((sig) => {
                const count = signalDist[sig] ?? 0;
                const pctVal = signalTotal > 0 ? ((count / signalTotal) * 100).toFixed(0) : "0";
                const emoji = sig === "accepted_without_edit" ? "🟢" : sig === "accepted_with_edit" ? "🟡" : sig === "regenerated" ? "🟠" : "🔴";
                return `<tr><td>${emoji} ${sig.replace(/_/g, " ")}</td><td>${count}</td><td>${pctVal}%</td></tr>`;
              })
              .join("")
          }
          <tr style="font-weight:600"><td>Avg true quality</td><td colspan="2">${(stats.avgTrueQuality * 100).toFixed(0)}%</td></tr>
        </tbody>
      </table>`;
  const learnedRows = Object.entries(stats.learnedStrategies ?? {})
    .map(
      ([intent, strat]) => `
        <tr>
          <td>${intent}</td>
          <td><span class="strat-badge">${strat}</span></td>
          <td>${stats.byIntent[intent]?.count ?? 0} samples</td>
        </tr>`
    )
    .join("");

  const learnedSection = Object.keys(stats.learnedStrategies ?? {}).length === 0
    ? `<p class="empty">No learned strategies yet — needs ≥ 3 samples per intent.</p>`
    : `<table>
        <thead><tr><th>Intent</th><th>Learned Strategy</th><th>Data</th></tr></thead>
        <tbody>${learnedRows}</tbody>
      </table>`;

  // ── Strategy Cache section ──────────────────────────────────────────────────
  const cacheSection = cacheStats.totalEntries === 0
    ? `<p class="empty">No cached strategies yet — improves after first optimizations.</p>`
    : `<div class="stats-grid" style="margin-bottom:12px">
        <div class="stat-card">
          <div class="stat-value">${cacheStats.totalEntries}</div>
          <div class="stat-label">Cache Keys</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${cacheStats.totalHits}</div>
          <div class="stat-label">Cache Hits</div>
        </div>
      </div>
      <table>
        <thead><tr><th>Key (short)</th><th>Best Strategy</th><th>Best Score</th><th>Hits</th></tr></thead>
        <tbody>
          ${cacheStats.topEntries.map((e) =>
            `<tr>
              <td><code style="font-size:0.72rem">${e.key.slice(0, 14)}\u2026</code></td>
              <td><span class="strat-badge">${e.strategy}</span></td>
              <td>${(e.bestScore * 100).toFixed(0)}%</td>
              <td>${e.hits}</td>
            </tr>`
          ).join("")}
        </tbody>
      </table>`;

  // ── Adaptive Graph section ──────────────────────────────────────────────────
  const graphSection = topNodes.length === 0
    ? `<p class="empty">No node weights yet — improves as you use reaction buttons after optimizations.</p>`
    : `<table>
        <thead><tr><th>Node</th><th>Learned Weight</th><th>Signal</th></tr></thead>
        <tbody>
          ${topNodes.map((n) => {
            const w = (n.weight * 100).toFixed(0);
            const bar = n.weight >= 0.7 ? "🟢" : n.weight >= 0.5 ? "🟡" : "🔴";
            const shortId = n.nodeId.split(/[/\\]/).pop() ?? n.nodeId;
            return `<tr>
              <td><code style="font-size:0.75rem">${shortId}</code></td>
              <td>
                <div style="background:#e6e6e6;border-radius:4px;height:8px;width:120px;display:inline-block;vertical-align:middle">
                  <div style="background:#464feb;border-radius:4px;height:8px;width:${w}%"></div>
                </div>
                &nbsp;${w}%
              </td>
              <td>${bar}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
  const intentSection = noData
    ? `<p class="empty">No data yet — press <kbd>Ctrl+Shift+O</kbd> to optimize your first prompt.</p>`
    : `<table>
        <thead>
          <tr>
            <th>Intent</th>
            <th>Count</th>
            <th>Accept Rate</th>
            <th>Avg Tokens Saved</th>
          </tr>
        </thead>
        <tbody>${intentRows}</tbody>
      </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>Copilot Optimizer v2</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: 14px;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      padding: 28px 32px;
      line-height: 1.6;
    }

    a {
      text-decoration: none;
      color: #464feb;
    }

    tr th, tr td {
      border: 1px solid #e6e6e6;
      padding: 8px 14px;
      text-align: left;
    }

    tr th {
      background-color: #f5f5f5;
      color: #1a1a1a;
      font-weight: 600;
    }

    h1 {
      font-size: 1.5rem;
      color: #464feb;
      margin-bottom: 4px;
      letter-spacing: -0.3px;
    }

    h2 {
      font-size: 1rem;
      font-weight: 600;
      margin: 28px 0 12px;
      opacity: 0.85;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .subtitle { opacity: 0.55; font-size: 0.85rem; margin-bottom: 24px; }

    .badge {
      display: inline-block;
      background: #464feb22;
      color: #464feb;
      border: 1px solid #464feb44;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 0.75rem;
      margin-left: 8px;
      vertical-align: middle;
    }

    .tag {
      display: inline-block;
      font-size: 0.7rem;
      padding: 1px 8px;
      border-radius: 10px;
      margin-left: 6px;
      background: #22c55e22;
      color: #22c55e;
      border: 1px solid #22c55e44;
      vertical-align: middle;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 14px;
      margin: 14px 0;
    }

    .stat-card {
      background: var(--vscode-editor-inactiveSelectionBackground, #2a2a2a);
      border: 1px solid var(--vscode-panel-border, #3a3a3a);
      border-radius: 10px;
      padding: 18px 14px;
      text-align: center;
    }

    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: #464feb;
      line-height: 1.1;
    }

    .stat-label {
      font-size: 0.72rem;
      opacity: 0.65;
      margin-top: 6px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }

    .empty {
      text-align: center;
      opacity: 0.45;
      padding: 32px 0;
      font-style: italic;
    }

    kbd {
      background: var(--vscode-editor-inactiveSelectionBackground, #2a2a2a);
      border: 1px solid var(--vscode-panel-border, #555);
      border-radius: 4px;
      padding: 1px 6px;
      font-family: monospace;
      font-size: 0.85em;
    }

    .arch {
      background: var(--vscode-editor-inactiveSelectionBackground, #2a2a2a);
      border: 1px solid var(--vscode-panel-border, #3a3a3a);
      border-radius: 10px;
      padding: 18px 22px;
      font-family: monospace;
      font-size: 0.85rem;
      line-height: 1.9;
    }

    .arch-row { display: flex; align-items: center; gap: 10px; }
    .arch-icon { width: 26px; text-align: center; }

    .arch-label {
      background: #464feb18;
      color: #464feb;
      border: 1px solid #464feb33;
      border-radius: 6px;
      padding: 3px 14px;
      min-width: 320px;
    }

    .arch-arrow { color: #464feb88; padding-left: 8px; }

    .shortcut-row td:last-child { font-family: monospace; }

    .strat-badge {
      display: inline-block;
      font-size: 0.72rem;
      padding: 2px 9px;
      border-radius: 10px;
      background: #464feb22;
      color: #464feb;
      border: 1px solid #464feb44;
      font-weight: 600;
    }

    code { font-family: monospace; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>Copilot Optimizer <span class="badge">v6 — Adaptive LLM Execution Engine</span></h1>
  <p class="subtitle">
    Intent-aware · Reasoning control · Orthogonal search · Fuzzy cache ·
    Node decay · <a href="#">confidence-aware adaptive learning</a>
  </p>

  <h2>Overview</h2>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${stats.totalEntries}</div>
      <div class="stat-label">Optimizations</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${pct(stats.acceptanceRate)}</div>
      <div class="stat-label">Accept Rate</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.avgTokensSaved.toFixed(0)}</div>
      <div class="stat-label">Avg Tokens Saved</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${Object.keys(stats.byIntent).length}</div>
      <div class="stat-label">Intent Types</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.avgTrueQuality > 0 ? pct(stats.avgTrueQuality) : '—'}</div>
      <div class="stat-label">True Quality</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${cacheStats.totalHits}</div>
      <div class="stat-label">Cache Hits</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">120</div>
      <div class="stat-label">Token Budget Cap</div>
    </div>
  </div>

  <h2>Architecture <span class="tag">v2</span></h2>
  <div class="arch">
    <div class="arch-row"><span class="arch-icon">📥</span><span class="arch-label">[1] Intent Engine — classify + confidence score</span></div>
    <div class="arch-row"><span class="arch-icon"></span><span class="arch-arrow">↓</span></div>
    <div class="arch-row"><span class="arch-icon">🔍</span><span class="arch-label">[2] Prompt Scorer — pre-flight quality check</span></div>
    <div class="arch-row"><span class="arch-icon"></span><span class="arch-arrow">↓ 4 orthogonal variants if score &lt; threshold</span></div>
    <div class="arch-row"><span class="arch-icon">🎯</span><span class="arch-label">[3] Strategy Engine — compression · depth · format · <strong>reasoning mode</strong></span></div>
    <div class="arch-row"><span class="arch-icon"></span><span class="arch-arrow">↓</span></div>
    <div class="arch-row"><span class="arch-icon">⚙️</span><span class="arch-label">[4] Prompt Compiler — AST → bytecode → structured</span></div>
    <div class="arch-row"><span class="arch-icon"></span><span class="arch-arrow">↓</span></div>
    <div class="arch-row"><span class="arch-icon">🧩</span><span class="arch-label">[5] Context Engine — graph + intent_match ranking</span></div>
    <div class="arch-row"><span class="arch-icon"></span><span class="arch-arrow">↓</span></div>
    <div class="arch-row"><span class="arch-icon">⚡</span><span class="arch-label">[6] Token Optimizer — intent-aware compression</span></div>
    <div class="arch-row"><span class="arch-icon"></span><span class="arch-arrow">↓</span></div>
    <div class="arch-row"><span class="arch-icon">💰</span><span class="arch-label">[7] Budget Controller — hard 120-token cap</span></div>
    <div class="arch-row"><span class="arch-icon"></span><span class="arch-arrow">↓</span></div>
    <div class="arch-row"><span class="arch-icon">🤖</span><span class="arch-label">Copilot API</span></div>
    <div class="arch-row"><span class="arch-icon"></span><span class="arch-arrow">↓</span></div>
    <div class="arch-row"><span class="arch-icon">📊</span><span class="arch-label">[8] Response Scorer — post-flight quality analysis</span></div>
    <div class="arch-row"><span class="arch-icon"></span><span class="arch-arrow">↓ re-optimize if score &lt; 0.6</span></div>
    <div class="arch-row"><span class="arch-icon">🔁</span><span class="arch-label">[9] Feedback Loop — adaptive learning + <strong>implicit signal scoring</strong></span></div>
  </div>

  <h2>Intent Strategy Map</h2>
  <table>
    <thead>
      <tr>
        <th>Intent</th>
        <th>Compression</th>
        <th>Context Depth</th>
        <th>Output Format</th>
        <th>Top-N</th>
        <th>Output Constraints</th>
        <th>Output Shape</th>
        <th>Reasoning Mode</th>
      </tr>
    </thead>
    <tbody>${strategyRows}</tbody>
  </table>

  <h2>Learned Strategies <span class="tag">adaptive</span></h2>
  ${learnedSection}

  <h2>Strategy Cache <span class="tag">memory</span></h2>
  ${cacheSection}

  <h2>Adaptive Graph <span class="tag">context learning</span></h2>
  ${graphSection}

  <h2>True Quality <span class="tag">implicit signals</span></h2>
  ${trueQualitySection}

  <h2>By Intent (feedback)</h2>
  ${intentSection}

  <h2>v1 vs v2</h2>
  ${compTable}

  <h2>Shortcuts</h2>
  <table>
    <thead><tr><th>Command</th><th>Shortcut / How to invoke</th></tr></thead>
    <tbody class="shortcut-row">
      <tr><td>Optimize Prompt</td><td><kbd>Ctrl+Shift+O</kbd></td></tr>
      <tr><td>Score Response</td><td>Button after optimization · Command Palette</td></tr>
      <tr><td>Toggle Autopilot</td><td>Status bar (bottom-right)</td></tr>
      <tr><td>Show Dashboard</td><td><kbd>Copilot Optimizer: Show Dashboard</kbd></td></tr>
      <tr><td>Rebuild Context Graph</td><td><kbd>Copilot Optimizer: Rebuild Context Graph</kbd></td></tr>
    </tbody>
  </table>
</body>
</html>`;
}

