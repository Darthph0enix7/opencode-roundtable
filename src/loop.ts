// opencode-roundtable — Debate loop state machine

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RoundtableConfig, DebateState, RoundRecord } from "./types.js";
import { createDebateState, DEBATERS, evaluateStopping, estimateTokens } from "./types.js";
import { runRound } from "./round.js";
import { scoreRound, synthesize } from "./critic.js";

export interface LoopResult {
  state: DebateState;
  synthesis: string;
  elapsedMs: number;
}

export async function runLoop(
  client: OpencodeClient,
  query: string,
  config: RoundtableConfig,
  directory: string,
): Promise<LoopResult> {
  const state = createDebateState(query, config);
  state.status = "deliberating";

  while (state.status === "deliberating") {
    state.round++;

    const ctx = {
      query: state.query,
      round: state.round,
      config: state.config,
      runningBrief: state.runningBrief,
      directory,
      lastRoundResponses: state.rounds.length > 0
        ? state.rounds[state.rounds.length - 1].responses
        : null,
    };

    const responses = await runRound(client, config, ctx);
    state.activeDebaterCount = responses.filter(r => !r.error).length;

    const roundRecord: RoundRecord = { round: state.round, responses };
    state.rounds.push(roundRecord);

    // Quorum check early
    if (state.activeDebaterCount < 2) {
      state.status = "completed";
      break;
    }

    // Critic scoring
    const criticResult = await scoreRound(client, config, {
      query: state.query,
      round: state.round,
      maxRounds: config.maxRounds,
      consensusHistory: state.consensusHistory,
      responses,
      directory,
    });

    roundRecord.critic = criticResult;
    state.consensusHistory.push(criticResult.consensusScore);
    state.qualityHistory.push(criticResult.qualityScore);
    state.runningBrief = criticResult.runningBrief;

    // Stopping conditions
    const decision = evaluateStopping(state);
    if (decision.stop) state.status = "completed";

    // Context pressure check
    const totalDebateTokens = state.rounds.reduce(
      (sum, r) => sum + r.responses.reduce((s, resp) => s + estimateTokens(resp.text), 0), 0
    );
    if (totalDebateTokens > 120_000) {
      state.status = "completed";
      roundRecord.critic!.reasonIfStop = "context_pressure";
    }
  }

  // ── Final synthesis ────────────────────────────────────────────────────
  const lastCritic = state.rounds.length > 0
    ? state.rounds[state.rounds.length - 1].critic
    : null;
  const stopReason = lastCritic?.reasonIfStop ?? "unknown";
  const finalConsensus = state.consensusHistory.length > 0
    ? state.consensusHistory[state.consensusHistory.length - 1] : 0;
  const finalQuality = state.qualityHistory.length > 0
    ? state.qualityHistory[state.qualityHistory.length - 1] : 0;

  const debaterModels: Record<string, string> = {};
  for (const def of DEBATERS) {
    debaterModels[def.label] = config.debaterModel ?? "(session default)";
  }
  const criticModel = config.criticModel ?? "(session default)";

  const fullTranscript = state.rounds
    .map(r => {
      const responses = r.responses
        .map(resp => `### ${resp.label} (Round ${r.round})\n${resp.text}`)
        .join("\n\n");
      const criticNote = r.critic
        ? `\n\n**Critic (Round ${r.round}):** consensus=${r.critic.consensusScore}, quality=${r.critic.qualityScore}, decision=${r.critic.continueDecision}\n${r.critic.runningBrief}`
        : "";
      return `\n## Round ${r.round}\n${responses}${criticNote}`;
    })
    .join("\n\n---\n");

  const synthesis = await synthesize(client, config, {
    query: state.query,
    stopReason,
    roundsRun: state.round,
    finalConsensus,
    finalQuality,
    fullTranscript,
    debaterModels,
    criticModel,
    directory,
  });

  return { state, synthesis, elapsedMs: Date.now() - state.startTime };
}
