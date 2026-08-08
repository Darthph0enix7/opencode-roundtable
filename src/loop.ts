// opencode-roundtable — Debate loop state machine

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RoundtableConfig, DebateState, RoundRecord } from "./types.js";
import { createDebateState, DEBATERS, evaluateStopping, SAFETY_CAP_ROUNDS } from "./types.js";
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

  // ── Persistent session pool ─────────────────────────────────────────────
  // One session per debater + one for the critic, created ONCE and reused for
  // every round. Each debater's own statements accumulate in ITS session, so
  // it genuinely remembers and revises its own argumentation across rounds
  // (no spawn/delete churn, no own-history re-injection into prompts). The
  // critic's session accumulates all scoring rounds, letting the final
  // synthesis skip the full-transcript re-injection. All sessions are deleted
  // in the finally block below — on success, cancellation, or exception.
  const sessionPool: Record<string, string> = {};
  const ownedSessions: string[] = [];
  try {
    for (const def of DEBATERS) {
      try {
        const res = await client.session.create({ query: { directory } });
        if (res.data?.id) {
          sessionPool[def.name] = res.data.id;
          ownedSessions.push(res.data.id);
        }
      } catch { /* pool creation is best-effort; degrade to per-round sessions */ }
    }
    try {
      const res = await client.session.create({ query: { directory } });
      if (res.data?.id) {
        sessionPool["critic"] = res.data.id;
        ownedSessions.push(res.data.id);
      }
    } catch { /* best-effort */ }
  } catch { /* best-effort */ }

  try {
    return await runDebateWithPool(client, query, config, directory, state, sessionPool);
  } finally {
    // Always clean up pool sessions — the debate ended, was cancelled, or
    // threw. Never leak sessions into the server.
    for (const id of ownedSessions) {
      await client.session.delete({ path: { id } }).catch(() => {});
    }
  }
}

async function runDebateWithPool(
  client: OpencodeClient,
  query: string,
  config: RoundtableConfig,
  directory: string,
  state: DebateState,
  sessionPool: Record<string, string>,
): Promise<LoopResult> {
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

    const responses = await runRound(client, config, ctx, sessionPool);
    state.activeDebaterCount = responses.filter(r => !r.error).length;

    const roundRecord: RoundRecord = { round: state.round, responses };
    state.rounds.push(roundRecord);

    // Quorum check early
    if (state.activeDebaterCount < 2) {
      // Record the stop reason so final synthesis reports it correctly
      // instead of falling back to "unknown".
      roundRecord.critic = {
        consensusScore: 0,
        qualityScore: 0,
        continueDecision: "STOP",
        reasonIfStop: "insufficient_participants",
        runningBrief: "Too few debaters remain active to continue the debate.",
        heuristicFallback: true,
      };
      state.status = "completed";
      break;
    }

    // Critic scoring
    const criticResult = await scoreRound(client, config, {
      query: state.query,
      round: state.round,
      maxRounds: config.maxRounds ?? SAFETY_CAP_ROUNDS,
      consensusHistory: state.consensusHistory,
      responses,
      directory,
    }, sessionPool["critic"]);

    roundRecord.critic = criticResult;
    state.consensusHistory.push(criticResult.consensusScore);
    state.qualityHistory.push(criticResult.qualityScore);
    state.runningBrief = criticResult.runningBrief;

    // Stopping conditions — each only fires while still deliberating, so a
    // fired condition can never overwrite an earlier stop reason.
    if (state.status === "deliberating") {
      const decision = evaluateStopping(state);
      if (decision.stop) {
        state.status = "completed";
        roundRecord.critic!.reasonIfStop = decision.reason;  // preserve machine-determined stop reason
      }
    }

    // Hidden safety cap for unbounded debates (maxRounds: null).
    // Machine-only — never rendered into any prompt. The final critic
    // scoring above already ran honestly without knowing this cap.
    if (state.status === "deliberating" && config.maxRounds === null && state.round >= SAFETY_CAP_ROUNDS) {
      state.status = "completed";
      roundRecord.critic!.reasonIfStop = "max_rounds";
    }

    // Context pressure check (input + output tokens, incl. critic usage)
    if (state.status === "deliberating") {
      const totalDebateTokens = state.rounds.reduce(
        (sum, r) =>
          sum +
          r.responses.reduce(
            (s, resp) => s + resp.tokens.input + resp.tokens.output,
            0,
          ) +
          (r.critic ? r.critic.runningBrief.length * 0.77 : 0),
        0,
      );
      if (totalDebateTokens > 120_000) {
        state.status = "completed";
        roundRecord.critic!.reasonIfStop = "context_pressure";
      }
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
        .map(resp => `### ${resp.label} (Round ${r.round})${resp.error ? ` — ⚠️ FAILED: ${resp.error}` : ""}\n${resp.text}`)
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
  }, sessionPool["critic"]);

  return { state, synthesis, elapsedMs: Date.now() - state.startTime };
}
