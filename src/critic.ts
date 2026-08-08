// opencode-roundtable — Critic agent: scoring, consensus, synthesis
//
// The critic's system prompt (CRITIC_SYSTEM) is set in the agent config.
// We only send the per-round / per-final task as a user message.

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RoundtableConfig, DebaterResponse, CriticOutput } from "./types.js";
import { estimateTokens, withTimeout } from "./types.js";
import {
  CRITIC_SCORING_PROMPT,
  CRITIC_SYNTHESIS_PROMPT,
  modelFooter,
  roundHorizonParts,
  criticMaxRoundsRule,
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
  poolSessionId?: string,
  parentID?: string,
): Promise<CriticOutput> {
  const { query, round, maxRounds, consensusHistory, responses, directory } = ctx;

  const transcript = responses
    .map(r => `### ${r.label} (${r.error ? `⚠️ FAILED: ${r.error}` : "responded"})\n${r.text}`)
    .join("\n\n");

  const { roundSuffix, noLimitNote } = roundHorizonParts(config);
  const hidden = config.hideRoundLimit === true || config.maxRounds === null;

  const prompt = CRITIC_SCORING_PROMPT
    .replaceAll("{{query}}", query)
    .replaceAll("{{round}}", String(round))
    .replaceAll("{{roundSuffix}}", roundSuffix)
    .replaceAll("{{noLimitNote}}", noLimitNote)
    .replaceAll("{{maxRounds}}", hidden ? "" : String(config.maxRounds))
    .replaceAll("{{maxRoundsRule}}", criticMaxRoundsRule(hidden))
    .replaceAll("{{consensusHistory}}", JSON.stringify(consensusHistory))
    .replaceAll("{{roundTranscript}}", transcript);

  // Attempt 1: call critic normally
  let output = await callCritic(client, config, prompt, directory, poolSessionId, parentID);
  if (output) return output;

  // Attempt 2: retry with explicit format reminder (low-friction formatting hint)
  const retryPrompt = `${prompt}\n\n---\nREMINDER: Respond with VALID JSON ONLY. No markdown fences, no prose. Schema: { "consensusScore": number, "qualityScore": number, "continueDecision": "STOP" | "CONTINUE", "reasonIfStop": string | null, "runningBrief": string }`;
  output = await callCritic(client, config, retryPrompt, directory, poolSessionId, parentID);
  if (output) return output;

  // Fall back to heuristic
  return heuristicScore(ctx);
}

// ── Call the critic session ─────────────────────────────────────────────────

async function callCritic(
  client: OpencodeClient,
  config: RoundtableConfig,
  prompt: string,
  directory: string,
  poolSessionId?: string,
  parentID?: string,
): Promise<CriticOutput | null> {
  try {
    // Persistent critic session: reuse the pool session when available.
    // Its history accumulates every scoring round, so the final synthesis
    // can reference the debate without a full transcript re-injection.
    let sessionId: string | undefined = poolSessionId;
    let createdHere = false;
    if (!sessionId) {
      const createResult = await client.session.create({
        query: { directory },
        body: parentID ? { parentID } : undefined,
      });
      if (createResult.error) return null;
      sessionId = createResult.data.id;
      createdHere = true;
    }

    try {
      const promptResult = await withTimeout(
        client.session.prompt({
          path: { id: sessionId },
          body: {
            agent: "roundtable-critic",  // OpenCode uses the agent's prompt as system message
            parts: [{ type: "text", text: prompt }],
          },
        }),
        config.perAgentTimeout,
        "critic scoring",
      );

      if (promptResult.error) return null;
      if (promptResult.data.info.error) return null;

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
    } finally {
      if (createdHere) {
        await client.session.delete({ path: { id: sessionId } }).catch(() => {});
      }
    }
  } catch {
    return null;
  }
}

// ── Heuristic fallback scoring ──────────────────────────────────────────────

function heuristicScore(ctx: ScoreContext): CriticOutput {
  const { round, maxRounds, responses } = ctx;
  const active = responses.filter(r => !r.error);
  const activeCount = active.length;

  let consensus = 0.5;
  if (activeCount >= 2) {
    const texts = active.map(r => r.text.toLowerCase());
    // Strip common stop-words so English filler doesn't fake agreement.
    const stopWords = new Set(
      "the a an and or but of to in on for with as at by is are was were be been being it its this that these those i you he she we they my your our their not no so if then than from into over under".split(" "),
    );
    const wordSets = texts.map(t =>
      new Set(
        t.split(/\s+/)
          .filter(w => w.length > 2 && !stopWords.has(w))
          .slice(0, 100),
      ),
    );
    // Average Jaccard overlap across ALL pairs (not just [0] vs [1]).
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < wordSets.length; i++) {
      for (let j = i + 1; j < wordSets.length; j++) {
        const a = wordSets[i];
        const b = wordSets[j];
        const inter = [...a].filter(w => b.has(w)).length;
        total += inter / Math.max(a.size + b.size - inter, 1);
        pairs++;
      }
    }
    consensus = pairs > 0 ? total / pairs : 0.5;
    consensus = clamp(consensus, 0, 1);
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
  poolSessionId?: string,
  parentID?: string,
): Promise<string> {
  const prompt = CRITIC_SYNTHESIS_PROMPT
    .replaceAll("{{stopReason}}", ctx.stopReason)
    .replaceAll("{{roundsRun}}", String(ctx.roundsRun))
    .replaceAll("{{finalConsensus}}", String(ctx.finalConsensus))
    .replaceAll("{{finalQuality}}", String(ctx.finalQuality))
    .replaceAll("{{modelFooter}}", modelFooter(ctx.debaterModels, ctx.criticModel))
    .replaceAll("{{fullTranscript}}", ctx.fullTranscript);

  try {
    let sessionId: string | undefined = poolSessionId;
    let createdHere = false;
    if (!sessionId) {
      const createResult = await client.session.create({
        query: { directory: ctx.directory },
        body: parentID ? { parentID } : undefined,
      });
      if (createResult.error) return `## Council Decision\n\nCritic synthesis failed: session creation error.\n\n${ctx.fullTranscript}`;
      sessionId = createResult.data.id;
      createdHere = true;
    }

    try {
      const promptResult = await withTimeout(
        client.session.prompt({
          path: { id: sessionId },
          body: {
            agent: "roundtable-critic",
            parts: [{ type: "text", text: prompt }],
          },
        }),
        config.perAgentTimeout,
        "critic synthesis",
      );

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
    } finally {
      if (createdHere) {
        await client.session.delete({ path: { id: sessionId } }).catch(() => {});
      }
    }
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
  // Non-greedy block-by-block extraction: try each {...} region in turn.
  // (A greedy [\s\S]* match spans multiple brace pairs and fails to parse.)
  const blocks = text.match(/\{[\s\S]*?\}/g);
  if (blocks) {
    for (const block of blocks) {
      try { return JSON.parse(block) as Record<string, unknown>; } catch {}
    }
  }
  return null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
