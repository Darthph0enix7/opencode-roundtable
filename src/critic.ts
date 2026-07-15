// opencode-roundtable — Critic agent: scoring, consensus, synthetic evaluation

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RoundtableConfig, DebaterResponse, CriticOutput } from "./types.js";
import {
  CRITIC_SCORING,
  CRITIC_SYNTHESIS,
  modelFooter,
} from "./prompts.js";

// ── Scoring round ───────────────────────────────────────────────────────────

interface ScoreContext {
  query: string;
  round: number;
  maxRounds: number;
  consensusHistory: number[];
  responses: DebaterResponse[];
  directory: string;
}

export async function scoreRound(
  client: OpencodeClient,
  config: RoundtableConfig,
  ctx: ScoreContext,
): Promise<CriticOutput> {
  const { query, round, maxRounds, consensusHistory, responses, directory } = ctx;

  const transcript = responses
    .map(r => `### ${r.label} (${r.error ? `⚠️ FAILED: ${r.error}` : "responded"})\n${r.text}`)
    .join("\n\n");

  const prompt = CRITIC_SCORING
    .replaceAll("{{query}}", query)
    .replaceAll("{{round}}", String(round))
    .replaceAll("{{maxRounds}}", String(maxRounds))
    .replaceAll("{{consensusHistory}}", JSON.stringify(consensusHistory))
    .replaceAll("{{roundTranscript}}", transcript);

  for (let attempt = 0; attempt <= config.criticRetries; attempt++) {
    try {
      const output = await callCritic(client, config, prompt, directory);
      if (output) return output;
      const retryPrompt = `Your previous output was not valid JSON. ${prompt}\n\nREMINDER: Output ONLY valid JSON. No markdown fences.`;
      const retryOutput = await callCritic(client, config, retryPrompt, directory);
      if (retryOutput) return retryOutput;
    } catch {
      // Fall through to heuristic
    }
    break;
  }

  return heuristicScore(ctx);
}

// ── Call the critic session ─────────────────────────────────────────────────

async function callCritic(
  client: OpencodeClient,
  config: RoundtableConfig,
  prompt: string,
  directory: string,
): Promise<CriticOutput | null> {
  try {
    const createResult = await client.session.create({ query: { directory } });
    if (createResult.error) return null;
    const sessionId = createResult.data.id;

    const promptResult = await client.session.prompt({
      path: { id: sessionId },
      body: {
        agent: "roundtable-critic",
        parts: [{ type: "text", text: prompt }],
      },
    });

    await client.session.delete({ path: { id: sessionId } }).catch(() => {});

    if (promptResult.error) return null;

    const text = promptResult.data.parts
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { text?: string }) => p.text ?? "")
      .join("");

    const json = extractJSON(text);
    if (!json) return null;

    return {
      consensusScore: clamp(Number(json.consensusScore) || 0, 0, 1),
      qualityScore: clamp(Number(json.qualityScore) || 0, 0, 1),
      continueDecision: json.continueDecision === "STOP" ? "STOP" : "CONTINUE",
      reasonIfStop: typeof json.reasonIfStop === "string" ? json.reasonIfStop : null,
      runningBrief: typeof json.runningBrief === "string" ? json.runningBrief : "No summary available.",
      heuristicFallback: false,
    };
  } catch {
    return null;
  }
}

// ── Heuristic fallback scoring ──────────────────────────────────────────────

function heuristicScore(ctx: ScoreContext): CriticOutput {
  const { round, maxRounds, responses } = ctx;
  const activeCount = responses.filter(r => !r.error).length;

  let consensus = 0.5;
  if (activeCount >= 2) {
    const texts = responses.filter(r => !r.error).map(r => r.text.toLowerCase());
    const words = texts.map(t => new Set(t.split(/\s+/).slice(0, 100)));
    const overlap = [...words[0]].filter(w => words[1].has(w)).length / Math.max(words[0].size, 1);
    consensus = clamp(overlap, 0, 1);
  }

  const adjustedConsensus = consensus * (1 - (round / maxRounds) * 0.3);

  return {
    consensusScore: Math.round(adjustedConsensus * 100) / 100,
    qualityScore: 0.5,
    continueDecision: round < maxRounds ? "CONTINUE" : "STOP",
    reasonIfStop: round >= maxRounds ? "max_rounds" : null,
    runningBrief: "Unable to produce summary (critic unavailable — heuristics used).",
    heuristicFallback: true,
  };
}

// ── Final synthesis ─────────────────────────────────────────────────────────

interface SynthesisContext {
  query: string;
  stopReason: string;
  roundsRun: number;
  finalConsensus: number;
  finalQuality: number;
  fullTranscript: string;
  debaterModels: Record<string, string>;
  criticModel: string;
  directory: string;
}

export async function synthesize(
  client: OpencodeClient,
  config: RoundtableConfig,
  ctx: SynthesisContext,
): Promise<string> {
  const prompt = CRITIC_SYNTHESIS
    .replaceAll("{{stopReason}}", ctx.stopReason)
    .replaceAll("{{roundsRun}}", String(ctx.roundsRun))
    .replaceAll("{{finalConsensus}}", String(ctx.finalConsensus))
    .replaceAll("{{finalQuality}}", String(ctx.finalQuality))
    .replaceAll("{{modelFooter}}", modelFooter(ctx.debaterModels, ctx.criticModel))
    .replaceAll("{{fullTranscript}}", ctx.fullTranscript);

  try {
    const createResult = await client.session.create({ query: { directory: ctx.directory } });
    if (createResult.error) return `## Council Decision\n\nCritic synthesis failed: session creation error.\n\n${ctx.fullTranscript}`;
    const sessionId = createResult.data.id;

    const promptResult = await client.session.prompt({
      path: { id: sessionId },
      body: {
        agent: "roundtable-critic",
        parts: [{ type: "text", text: prompt }],
      },
    });

    await client.session.delete({ path: { id: sessionId } }).catch(() => {});

    if (promptResult.error) {
      return `## Council Decision\n\nCritic synthesis failed: ${JSON.stringify(promptResult.error)}.\n\n${ctx.fullTranscript}`;
    }

    if (promptResult.data.info.error) {
      return `## Council Decision\n\nCritic synthesis error: ${promptResult.data.info.error.name}.\n\n${ctx.fullTranscript}`;
    }

    return promptResult.data.parts
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { text?: string }) => p.text ?? "")
      .join("");
  } catch (e) {
    return `## Council Decision\n\nCritic synthesis failed: ${e instanceof Error ? e.message : String(e)}.\n\n${ctx.fullTranscript}`;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractJSON(text: string): Record<string, unknown> | null {
  try { return JSON.parse(text) as Record<string, unknown>; } catch {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    try { return JSON.parse(match[1]) as Record<string, unknown>; } catch {}
  }
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]) as Record<string, unknown>; } catch {}
  }
  return null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
