# Copilot Optimizer AI

> **Get better Copilot answers automatically.**
> Fix prompts. Improve answers. Learn over time.

A smart layer between you and GitHub Copilot that improves results automatically — no manual tuning required.

---

## 🆕 Native chat: `@optimizer`

The fastest way to use it — talk to the optimizer **directly inside Copilot Chat**:

```
@optimizer fix the null pointer in UserService
```

You write naturally. Behind the scenes it rewrites your prompt, injects the real
contents of the most relevant workspace files, sends it to the model, **streams the
answer back**, and **automatically scores the response** so it keeps learning — all
without leaving the chat.

- **Slash commands:** `/debug` `/fix` `/refactor` `/explain` `/generate` `/raw` `/dashboard`
- **`/raw`** bypasses optimization so you can A/B compare against a plain prompt.
- **On/off:** toggle optimization from the status bar (bottom-right), or the
  `copilotOptimizer.enabled` setting.
- **Feedback buttons** (✓ / ✍ / ↩) under each answer refine the learning loop.

### Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| `copilotOptimizer.tokenBudget` | `400` | Accuracy ↔ token-savings preset (Max savings · Balanced · Accuracy-first · Maximum accuracy). Lower = more compression, higher = more context. |
| `copilotOptimizer.contextFiles` | `3` | How many top-ranked files to attach as real code. `0` = names only. |
| `copilotOptimizer.contextCharBudget` | `6000` | Max characters of file content sent to the model. |
| `copilotOptimizer.model` | `""` | Preferred Copilot model (e.g. Claude Opus 4.8, GPT-5.5). Empty = use the model picked in the chat dropdown. |
| `copilotOptimizer.enabled` | `true` | Master on/off for optimization. |

---

## Quick Start

| Action | How |
|--------|-----|
| **Optimize a prompt** | `Ctrl+Shift+O` — type prompt → press Enter → paste into Copilot |
| **Quick Send** (killer feature) | Select text → `Ctrl+Alt+Enter` → paste into Copilot |
| **Right-click** | Select any text → right-click → *Quick Send* |

That's it. The engine handles strategy, context, and compression for you.

---

## Example

**Before:**
```
please help me fix the null pointer exception in UserService
```

**After (`Ctrl+Alt+Enter`):**
```
fix: null pointer UserService
mode: debug
focus: root cause
minimal response
```

Copilot answers faster, more precisely, with less noise.

---

## Why it works

Bad prompts → vague answers → retries → wasted time.

The optimizer:
1. **Detects intent** — is this a fix, a feature, a question?
2. **Compresses** — removes noise, keeps signal
3. **Adds context** — ranks your codebase and injects relevant nodes
4. **Learns** — adapts strategy based on what worked before

---

## Features

| Feature | What it does |
|---------|-------------|
| **Intent detection** | Recognizes fix, feature, refactor, explain, test, docs |
| **Adaptive compression** | Removes filler words while preserving meaning |
| **Context graph** | Ranks your workspace files by relevance to the prompt |
| **Strategy memory** | Remembers what strategy worked best per intent |
| **Fuzzy cache** | Reuses cached strategies for similar contexts |
| **Confidence scoring** | Detects low-confidence results and retries with wider context |
| **Output shaping** | Tells Copilot how to format the answer |
| **Learning feedback** | Gets smarter every time you use it |

---

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Improve Prompt | `Ctrl+Shift+O` | Type a prompt → optimized result is copied |
| Quick Send | `Ctrl+Alt+Enter` | Selected text → optimize → copy instantly |
| Show Dashboard | Command Palette | Stats, learned strategies, context graph |
| Score Response | Command Palette | Rate a Copilot response to improve learning |
| Rebuild Graph | Command Palette | Re-scan workspace context |

---

## How the learning works

Every time you click **"✓ Great answer"** or **"↩ Regenerated"** after using the extension, the system:
- Updates which strategy works best for that intent
- Adjusts context node weights (which files matter for which prompts)
- Caches the winning strategy for similar future prompts

After ~10 uses, it becomes noticeably smarter for your specific codebase.

---

## Privacy

All optimization, scoring, and learning run **locally on your machine**.
No prompts, no code, and no codebase context are sent anywhere except your configured Copilot provider.

- Zero telemetry
- Zero external API calls
- All learning data stored in VS Code's per-user global storage on your machine

---

## Release Notes

### 1.1.0

- **Native `@optimizer` chat participant** — write naturally in Copilot Chat; it rewrites your prompt, sends it to the model, streams the answer, and auto-scores the response.
- **Real file-content context** — injects the actual code of the most relevant workspace files (not just file names) for far more accurate answers.
- **Slash commands** — `/debug` `/fix` `/refactor` `/explain` `/generate` `/raw` `/dashboard`.
- **Settings** — token-budget preset, context file/character budgets, preferred model, and a master on/off switch.
- **Working on/off toggle** — the status-bar switch now actually enables/disables optimization.
- **Fix** — learning data now persists in writable per-user global storage (previously failed silently when installed from the Marketplace).

### 1.0.0

- Adaptive learning engine (v6)
- Fuzzy cache matching (Jaccard similarity)
- Node weight decay (30-day half-life)
- Confidence scoring with automatic context expansion
- Quick Send (`Ctrl+Alt+Enter`) — zero-friction optimization
- RELEASE_MODE: stable 2-variant search

---

*Better prompts → better answers → fewer retries.*
