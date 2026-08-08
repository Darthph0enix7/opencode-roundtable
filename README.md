# opencode-roundtable

**Multi-agent debate AND brainstorming plugin for OpenCode.**

Two tools, one battle-tested engine:

- **`roundtable`** — adversarial multi-perspective debate. Three debaters (Skeptic, Pragmatist, Architect) cross-examine each other across rounds; a Critic scores consensus and synthesizes a council report with dissents.
- **`chorus`** — constructive multi-model brainstorming. Three creative lenses (Visionary, Experiencer, Integrator) BUILD on each other's ideas; a Curator dedupes, groups themes, spots gems, and detects when idea generation plateaus. Turns a vague vision into a harvest of concrete feature options.

## What is it?

When you ask a hard architectural question, you usually want **multiple perspectives** and **a real discussion** — not a single model's confident-sounding answer. OpenCode's stock agents each call one model once. This plugin runs a proper debate:

- Round 1: each debater states their position independently
- Round 2+: each debater sees the others' positions, attacks the weakest point in each, revises their own
- After every round, the Critic scores consensus + quality, writes a running brief, decides whether to stop
- When the debate stops, the Critic synthesizes the final report with explicit dissents

The result is a council decision that **says plainly where it disagrees with itself** — not a flattened consensus.

## Installation

```bash
# The plugin is published at https://www.npmjs.com/package/opencode-roundtable
# Add it to OpenCode's plugin array:
```

In `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "opencode-roundtable"                  // zero-config
    // OR with options:
    // ["opencode-roundtable", { "mode": "light" }]
  ]
}
```

Then assign models per agent in OpenChamber settings (or let them inherit your session default).

## Usage

The `roundtable` **tool** is the single entry point (the standalone `roundtable`
primary agent was removed in v0.1.9 — the tool is invoked by the orchestrator
agent of your orchestration plugin, or by any agent with the tool granted).

```javascript
await tool.roundtable({
  query: "Should we replace Docker Compose with Kubernetes?",
  maxRounds: 5,        // optional; null = unbounded (hidden safety cap)
  hideLimit: true,     // optional — hide the round limit from agents
  debug: false,        // optional
});
```

## Chorus — creative brainstorming

Use `chorus` when you have a vague seed ("a custom assistant UI... I don't know what else") and want the feature space EXPANDED, not decided. It is the constructive counterpart to the debate tool: no opposing roles, no consensus — ideas build on ideas until genuinely new ones stop appearing.

```javascript
await tool.chorus({
  query: "A personal assistant app: what features beyond chat/voice/memory?",
  maxRounds: 4,        // optional; null = unbounded (hidden safety cap)
  hideLimit: true,     // optional — hide the round limit from participants
});
```

### Participants

| Agent | Role |
|-------|------|
| `chorus-visionary` | Dreams what it could BECOME — moonshots, what-if directions, 2-3 year horizons |
| `chorus-experiencer` | Lives in the user's daily moments — ideas as felt experience |
| `chorus-integrator` | Knows what today's stack enables — buildable directions with effort tags (now/soon/later) |
| `chorus-curator` | Chair — dedupes, groups themes, spots gems, detects plateau, writes the harvest |

### How it stops

Not by consensus — by **plateau**: the curator counts genuinely-new ideas per round, and the machine stops when fewer than `minNewIdeas` (default 2) appear. Also: max rounds, hidden safety cap, quorum, context guard, or user abort.

### Output — Idea Harvest

Themes (grouped, with who proposed + who built on each), Top Gems (clustered across lenses), Buildable-now vs Moonshot, Open Questions, and the Curator's recommendation. A menu for YOU to choose from — not a verdict.

## Configuration

All configuration is optional. Without arguments, the plugin uses sensible defaults inherited from the `standard` mode.

Pass options as the second tuple element in the plugin array:

```jsonc
"plugin": [
  ["opencode-roundtable", {
    "mode": "heavy",
    "maxRounds": 7,
    "consensusThreshold": 0.90
  }]
]
```

User-explicit values override mode-preset values, which override defaults.

### Operating modes

| Mode | maxRounds | consensus | quality | timeout | retries | use when |
|------|-----------|-----------|---------|---------|---------|----------|
| `light` | 3 | 0.75 | 0.70 | 60s | 1 | quick gut-check, cheap |
| `standard` (default) | 5 | 0.85 | 0.80 | 120s | 2 | most questions |
| `heavy` | 7 | 0.90 | 0.85 | 180s | 3 | architectural decisions |
| `free` | hidden (null) | 0.85 | 0.80 | 120s | 2 | debate runs as long as it needs — no announced limit |

### All parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | `"light" \| "standard" \| "heavy" \| "free"` | `"standard"` | Operating mode preset |
| `maxRounds` | number \| null | 5 / 3 / 7 / null | Machine-side round cap. `null` = unbounded (hidden safety cap 12). Never rendered into prompts when hidden. |
| `hideRoundLimit` | boolean | `false` | Hide the round limit from ALL agents (anti-deadline-pacing). The machine still enforces `maxRounds`. |
| `consensusThreshold` | number 0–1 | 0.85 / 0.75 / 0.90 | STOP when consensus ≥ threshold |
| `qualityThreshold` | number 0–1 | 0.80 / 0.70 / 0.85 | STOP when quality ≥ threshold AND consensus not improving |
| `minImprovementDelta` | number 0–1 | 0.05 | Required consensus delta to avoid "quality sufficient" STOP |
| `stalenessFloor` | number 0–1 | 0.02 | Consensus delta below this counts as "no progress" |
| `stalenessRounds` | number | 2 | Consecutive no-progress rounds → STOP |
| `divergenceThreshold` | number 0–1 | 0.10 | Consensus drop ≥ threshold → STOP (positions diverging) |
| `perAgentTimeout` | number (ms) | 120000 / 60000 / 180000 | Per-agent (debater or critic) timeout |
| `debaterMaxWords` | number | 500 / 350 / 700 | Max words per debater response |
| `debaterMinTokens` | number | 50 | Min token count for valid debater response (else retry) |
| `criticModel` | string \| null | `null` | Override critic's model (else inherits session default) |
| `debaterModel` | string \| null | `null` | Override debaters' model (else inherits session default) |
| `debaterRetries` | number | 2 / 1 / 3 | Retry count for failed debater invocations |
| `criticRetries` | number | 1 / 0 / 2 | Retry count for failed critic invocations |
| `enableDebaterTools` | boolean | `true` | Give debaters read-only research tools (read/glob/grep/webfetch/task) |
| `enableCriticTools` | boolean | `true` | Give critic read-only research tools (same) |
| `debug` | boolean | false | Include per-round scores + full state JSON in output |

### Per-call overrides (tool args)

When calling the `roundtable` tool, you can override two parameters at runtime:

```javascript
roundtable({
  query: "...",        // required
  maxRounds: 7,        // overrides config.maxRounds for this call
  hideLimit: true,     // overrides config.hideRoundLimit for this call
  debug: true,         // overrides config.debug for this call
});
```

All other parameters inherit from plugin config.

## The five agents

| Agent | Mode | Role | Default model |
|-------|------|------|---------------|
| `roundtable-skeptic` | subagent | **Adversarial critic** — finds logic holes, unstated assumptions, worst-case | inherits |
| `roundtable-pragmatist` | subagent | **Ship-now stance** — flags over-engineering, defends the boring choice | inherits |
| `roundtable-architect` | subagent | **Long-term shape** — checks coupling, blast radius, 3-year horizons | inherits |
| `roundtable-critic` | subagent | **Judge + synthesizer** — scores consensus, decides continue/stop, writes final report | inherits |

Each subagent has a detailed system prompt in the agent config explaining their epistemic position, what state they represent, and behavioral rules. Models are assignable per agent via OpenChamber settings.

### Tool access (research-by-default)

By default, all three debaters and the critic get **read-only research tools**:

| Tool | Purpose | Permission prompt? |
|------|---------|:------------------:|
| `read` | read project files (verify claims against actual code) | ❌ |
| `glob` | find files by pattern | ❌ |
| `grep` | search code text | ❌ |
| `webfetch` | fetch any URL (external docs, pricing pages, prior incidents) | ❌ |
| `websearch` | run web search (no-op if not installed) | ❌ |
| `task` | delegate to other installed subagents for deeper research | ❌ |
| `write`, `edit`, `bash` | **disabled by default** — would trigger permission prompts | — |

**The permission-prompt tradeoff:** `bash`, `write`, `edit` are intentionally disabled. In OpenCode, these trigger a permission prompt on every invocation, which would break the fire-and-forget debate UX (you'd come back to a debate waiting for 5+ approval clicks). The research surface is read-only — it can still verify claims, fetch docs, run web searches, and delegate to subagents for deeper investigation, all without permission prompts.

System prompts explicitly tell each agent to use these tools early ("a skeptical position backed by file paths and citations is unanswerable"). Disable per agent by setting `enableDebaterTools: false` or `enableCriticTools: false` in plugin options.

## How a debate runs

```
Round 1: parallel initial positions (independent)
  ↓
Critic scores consensus + quality + writes running brief
  ↓
STOP if any:
  - consensus ≥ threshold
  - quality ≥ threshold AND consensus not improving (≥0.05 delta needed)
  - consensus dropped ≥ threshold (positions diverging)
  - 2+ rounds of no progress
  - max rounds hit
  - <2 debaters active (failed)
  ↓
CONTINUE otherwise → Round 2: each debater sees others' positions + brief
  ↓
Critic scores again → loop until STOP
  ↓
Critic synthesizes final report (5 sections)
```

## Output format

```
[roundtable] Running multi-agent debate on: "<query>"
[roundtable] Complete — N round(s) in Xs

## Council Decision
(The agreed recommendation. If no consensus, say so plainly.)

## Dissent
(Where disagreement persisted, who held out, and why. Honest disagreement
 is the product — do not flatten it.)

## Debate Summary
- Rounds run: N
- Stop reason: <reason>
- Final consensus: <0.0–1.0>
- Final quality: <0.0–1.0>

## Open Questions
(What the debate did NOT resolve.)

## Models Used
| Role | Model |
|------|-------|
| Skeptic | <model> |
| Pragmatist | <model> |
| Architect | <model> |
| Critic | <model> |

---
*Debate ran N round(s) in Xs.*
```

## Stop reasons decoded

The "Stop reason" in Debate Summary can be any of:

| Reason | Means |
|--------|-------|
| `consensus_reached` | consensus ≥ threshold |
| `quality_sufficient` | quality ≥ threshold AND consensus not improving |
| `diverging` | consensus dropped by ≥ divergenceThreshold |
| `no_improvement` | 2+ rounds of negligible delta |
| `max_rounds` | hit maxRounds (or the hidden safety cap for unbounded debates) |
| `insufficient_participants` | <2 debaters active (failed/retry-exhausted) |
| `context_pressure` | a debate session exceeded the 60K-token per-session context estimate |
| `aborted_by_user` | the invoking session was cancelled — all debate sessions aborted + cleaned up |

## Failure handling

| What can fail | What happens |
|---------------|---------------|
| Debater returns < 50 tokens | Retry once with explicit reminder |
| Debater API error/timeout | Retry up to `debaterRetries`, then mark failed |
| All 3 debaters fail | STOP — `< 2 active` triggers |
| Critic returns unparseable JSON | Retry once with format reminder |
| Critic API error/timeout/empty response | Logged to console with the exact reason, heuristic fallback (keyword overlap + round count), marked "⚠️ (heuristic fallback)" in the report |

## Debug mode

Pass `debug: true` to the tool (or set `debug: true` in plugin config) to see:

- Per-round scores (consensus + quality + decision + reasonIfStop)
- Each debater's token count and short preview
- Full debate state JSON at the end

Useful for tuning thresholds and understanding why a debate stopped early.

## Architecture

7 source files, ~700 LOC TypeScript:

```
src/
├── index.ts          # v2 plugin entry: exports { id, server }
├── types.ts          # shared types, debate state, config, stopping conditions
├── prompts.ts        # all system prompts (5 roles) + round/synthesis instructions
├── round.ts          # spawn debaters via @opencode-ai/sdk, retry on failure
├── critic.ts         # JSON scoring + heuristic fallback + final synthesis
├── loop.ts           # debate state machine
└── roundtable.ts     # tool handler + result formatting
```

Plays by the v2 OpenCode plugin contract: `default export = { id, server }`, server returns `{ tool, config }`. Each agent's full system prompt is set in the `config` hook so OpenCode prepends it as the actual `system` message at inference time — runtime spawning only sends round-specific user messages.

State is **in-memory only** — no disk persistence. Debates are scoped to the calling session. Each debate uses a **persistent session pool** (one session per debater + critic, reused across rounds so participants remember their own arguments); all sessions are deleted in a `finally` block when the debate ends, is cancelled, or throws.

## Abort handling

If you cancel the session that invoked the roundtable tool, the runtime fires
the tool's `AbortSignal`. The plugin listens for it and immediately:

1. Calls `session.abort()` on every pool session (kills in-flight generations — no token burn)
2. Stops the loop — no critic scoring, no next round, no synthesis
3. Deletes all sessions in the `finally` block

Debater/critic retries are abort-aware (never re-prompt after an abort). If the
debate ends early this way, the tool returns a short `## Debate Aborted` note.
Session cleanup retries 3× with backoff and logs failures, so broken leftover
sessions don't linger.

## Hidden round limit (anti-deadline-pacing)

When `hideRoundLimit: true` (or `maxRounds: null`), the debaters and critic are
**never told** the round horizon ("Round X of Y" is dropped from prompts and the
critic's max-round trigger is removed). LLMs pace their scoring against an
announced schedule; hiding it makes the debate length emerge from content. The
machine still enforces the cap deterministically.

## Persistent sessions

Each debate creates ONE session per debater + one for the critic, reused across
all rounds. Debaters retain their own full argumentation history (no re-injection,
no spawn/delete churn); the critic's session accumulates every scoring round, so
the final synthesis runs without re-injecting the full transcript. All sessions
are deleted when the debate finishes, is aborted, or throws.

## Development

```bash
git clone https://github.com/Darthph0enix7/opencode-roundtable.git
cd opencode-roundtable
bun install
bun run build         # → dist/index.js (single file, ~430KB with zod bundled)

# For local testing, install from your checkout:
npm install -g .

# Then add to opencode.jsonc plugin array:
"opencode-roundtable"   # works because npm install creates a global symlink

# Versioning + publishing:
npm version patch
npm publish --access public
```

## License

MIT.
