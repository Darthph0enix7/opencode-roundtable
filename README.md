# opencode-roundtable

**Multi-agent roundtable debate plugin for OpenCode.**

Puts three debaters (Skeptic, Pragmatist, Architect) and a Critic at a table, runs them across multiple rounds with real cross-examination, and synthesizes a council report with dissents and model-usage footer.

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
    "oh-my-opencode-slim",
    "@cortexkit/opencode-magic-context",
    "opencode-roundtable"                 // zero-config
    // OR with options:
    // ["opencode-roundtable", { "mode": "light" }]
  ]
}
```

Then assign models per agent in OpenChamber settings (or let them inherit your session default).

## Usage

Three invocation paths:

### Path 1 — `@roundtable` in any chat

```
@roundtable Should I migrate from oh-my-opencode-slim to a custom orchestrator?
```

### Path 2 — Tool call from any agent

Any agent can call the `roundtable` tool directly:

```javascript
// In another agent's prompt, the model decides to invoke:
await tool.roundtable({
  query: "Should we replace Docker Compose with Kubernetes?",
  maxRounds: 5,        // optional, default: 5
  debug: false,        // optional, default: false
});
```

### Path 3 — Slash command (in TUI)

```
/roundtable Should I keep using SQLite for embedded deployments?
```

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

### All parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | `"light" \| "standard" \| "heavy"` | `"standard"` | Operating mode preset |
| `maxRounds` | number | 5 / 3 / 7 | Maximum debate rounds before forced stop |
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
  debug: true,         // overrides config.debug for this call
});
```

All other parameters inherit from plugin config.

## The five agents

| Agent | Mode | Role | Default model |
|-------|------|------|---------------|
| `roundtable` | primary | Orchestrator — calls the roundtable tool, returns result verbatim | inherits |
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
| `max_rounds` | hit maxRounds |
| `insufficient_participants` | <2 debaters active (failed/retry-exhausted) |
| `context_pressure` | debate exceeded ~120K total tokens (debate is over) |

## Failure handling

| What can fail | What happens |
|---------------|---------------|
| Debater returns < 50 tokens | Retry once with explicit reminder |
| Debater API error/timeout | Retry up to `debaterRetries`, then mark failed |
| All 3 debaters fail | STOP — `< 2 active` triggers |
| Critic returns unparseable JSON | Retry once with format reminder |
| Critic API error/timeout | Heuristic fallback: keyword overlap + round count, marked as "heuristics used" |

## Debug mode

Pass `debug: true` to the tool (or set `debug: true` in plugin config) to see:

- Per-round scores (consensus + quality + decision + reasonIfStop)
- Each debater's token count and short preview
- Full debate state JSON at the end

Useful for tuning thresholds and understanding why a debate stopped early.

## Architecture

7 source files, ~450 LOC TypeScript:

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

State is **in-memory only** — no disk persistence. Debates are scoped to the calling session.

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
