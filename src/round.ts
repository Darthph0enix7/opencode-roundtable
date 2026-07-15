// opencode-roundtable — Debate round: spawn debaters, validate, retry

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RoundtableConfig, DebaterResponse, DebaterDef } from "./types.js";
import { DEBATERS, estimateTokens } from "./types.js";
import {
  SKEPTIC_SYSTEM,
  PRAGMATIST_SYSTEM,
  ARCHITECT_SYSTEM,
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

  const systems: Record<string, string> = {
    "roundtable-skeptic":    SKEPTIC_SYSTEM,
    "roundtable-pragmatist": PRAGMATIST_SYSTEM,
    "roundtable-architect":  ARCHITECT_SYSTEM,
  };

  let system = (systems[def.name] ?? "")
    .replaceAll("{{maxWords}}", String(config.debaterMaxWords));

  if (round === 1 || !lastRoundResponses || lastRoundResponses.length === 0) {
    const body = ROUND_1_DEBATER_INSTRUCTION
      .replaceAll("{{query}}", query);
    return `${system}\n\n${body}`;
  }

  const others = lastRoundResponses.filter(r => r.agentName !== def.name);
  const shuffled = [...others];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const transcript = shuffled
    .map(r => `### ${r.label} (${r.error ? `⚠️ FAILED: ${r.error}` : "responded"})\n${r.text}`)
    .join("\n\n");

  const body = ROUND_N_DEBATER_INSTRUCTION
    .replaceAll("{{query}}", query)
    .replaceAll("{{runningBrief}}", runningBrief || "(none)")
    .replaceAll("{{roundTranscript}}", transcript)
    .replaceAll("{{round}}", String(round))
    .replaceAll("{{maxRounds}}", String(config.maxRounds));

  return `${system}\n\n${body}`;
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
    // For retries, add format reminder
    const effectivePrompt = attempt > 0
      ? `Previous response was invalid. ${prompt}\n\nReminder: minimum 50 words.`
      : prompt;

    try {
      // Create session
      const createResult = await client.session.create({
        query: { directory },
      });
      if (createResult.error) {
        lastError = `create: ${createResult.error}`;
        continue;
      }
      const sessionId = createResult.data.id;

      // Send prompt with agent assignment
      const promptResult = await client.session.prompt({
        path: { id: sessionId },
        body: {
          agent: def.name,
          parts: [{ type: "text", text: effectivePrompt }],
        },
      });

      // Cleanup session regardless of result
      await client.session.delete({ path: { id: sessionId } }).catch(() => {});

      if (promptResult.error) {
        lastError = `prompt: ${promptResult.error}`;
        continue;
      }

      const { info, parts } = promptResult.data;

      // Check message-level error
      if (info.error) {
        lastError = info.error.name ?? "message_error";
        // Don't retry context overflow errors
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

      // Min-token check
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

  // All retries exhausted
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
