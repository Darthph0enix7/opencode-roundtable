// opencode-roundtable — Debate round: spawn debaters, validate, retry
//
// System prompts are NOT inlined into the user message. Each debater agent
// has its own `prompt` in opencode.jsonc → OpenCode prepends it as the system
// message at inference time. We only send the round-specific user message.

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RoundtableConfig, DebaterResponse, DebaterDef } from "./types.js";
import { DEBATERS, estimateTokens } from "./types.js";
import {
  ROUND_1_DEBATER_INSTRUCTION,
  ROUND_N_DEBATER_INSTRUCTION,
} from "./prompts.js";

// ── Round context builder ───────────────────────────────────────────────────

interface RoundContext {
  query: string;
  round: number;
  config: RoundtableConfig;
  runningBrief: string;
  directory: string;
  lastRoundResponses: DebaterResponse[] | null;
}

export function buildDebaterPrompt(def: DebaterDef, ctx: RoundContext): string {
  const { query, round, config, runningBrief, lastRoundResponses } = ctx;

  // Round 1: just the question + initial-position instructions.
  if (round === 1 || !lastRoundResponses || lastRoundResponses.length === 0) {
    return ROUND_1_DEBATER_INSTRUCTION.replaceAll("{{query}}", query);
  }

  // Round N: randomize order of other debaters' positions (prevents recency bias).
  const others = lastRoundResponses.filter(r => r.agentName !== def.name);
  const shuffled = [...others];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const transcript = shuffled
    .map(r => `### ${r.label} (${r.error ? `⚠️ FAILED: ${r.error}` : "responded"})\n${r.text}`)
    .join("\n\n");

  return ROUND_N_DEBATER_INSTRUCTION
    .replaceAll("{{query}}", query)
    .replaceAll("{{runningBrief}}", runningBrief || "(none yet — this is the first cross-examination round)")
    .replaceAll("{{roundTranscript}}", transcript)
    .replaceAll("{{round}}", String(round))
    .replaceAll("{{maxRounds}}", String(config.maxRounds));
}

// ── Spawn a single debater ──────────────────────────────────────────────────

export async function spawnDebater(
  client: OpencodeClient,
  def: DebaterDef,
  prompt: string,
  config: RoundtableConfig,
  directory: string,
): Promise<DebaterResponse> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= config.debaterRetries; attempt++) {
    const effectivePrompt = attempt > 0
      ? `Previous response was invalid. ${prompt}\n\nReminder: respond in 50–500 words of plain prose.`
      : prompt;

    try {
      const createResult = await client.session.create({ query: { directory } });
      if (createResult.error) {
        lastError = `create: ${JSON.stringify(createResult.error)}`;
        continue;
      }
      const sessionId = createResult.data.id;

      const promptResult = await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: def.name,  // OpenCode uses def.name's agent prompt as system message
          parts: [{ type: "text", text: effectivePrompt }],
        },
      });

      await client.session.delete({ path: { id: sessionId } }).catch(() => {});

      if (promptResult.error) {
        lastError = `prompt: ${JSON.stringify(promptResult.error)}`;
        continue;
      }

      const { info, parts } = promptResult.data;

      if (info.error) {
        lastError = info.error.name ?? "message_error";
        if (info.error.name === "context_overflow") break;
        continue;
      }

      const text = parts
        .filter((p: { type: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("");

      const tokens = {
        input:  info.tokens?.input  ?? estimateTokens(effectivePrompt),
        output: info.tokens?.output ?? estimateTokens(text),
      };

      if (tokens.output < config.debaterMinTokens) {
        lastError = `response too short (${tokens.output} tokens)`;
        continue;
      }

      return {
        agentName: def.name,
        label: def.label,
        text,
        tokens,
        error: null,
      };
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt === config.debaterRetries) break;
    }
  }

  return {
    agentName: def.name,
    label: def.label,
    text: "",
    tokens: { input: 0, output: 0 },
    error: lastError ?? "unknown error",
  };
}

// ── Run one full round ──────────────────────────────────────────────────────

export async function runRound(
  client: OpencodeClient,
  config: RoundtableConfig,
  ctx: RoundContext,
): Promise<DebaterResponse[]> {
  const prompts = DEBATERS.map(def => ({
    def,
    prompt: buildDebaterPrompt(def, ctx),
  }));

  return await Promise.all(
    prompts.map(({ def, prompt }) =>
      spawnDebater(client, def, prompt, config, ctx.directory)
    )
  );
}
