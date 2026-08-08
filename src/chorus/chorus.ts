/**
 * Chorus — the brainstorming engine.
 *
 * Constructive multi-model ideation. Three creative lenses brainstorm in
 * parallel; a curator dedupes/group-themes/gem-spots after every round and
 * detects plateau. The machine stops when genuinely new ideas stop appearing.
 *
 * Shares the roundtable's battle-tested machinery: persistent session pool
 * (one session per participant + curator, deleted in a finally block),
 * AbortSignal handling (parent cancel → session.abort() all + stop), retry
 * discipline (never re-prompt after an abort), deterministic per-session
 * context guard.
 */

import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  CHORUS_ROLES,
  CHORUS_CURATOR,
  createChorusSession,
  DEFAULT_CHORUS_CONFIG,
  SAFETY_CAP_ROUNDS,
  type ChorusArgs,
  type ChorusConfig,
  type ChorusResult,
  type ChorusRound,
  type ChorusSession,
  type CurationOutput,
  type IdeaResponse,
} from "./types.js";
import { loadChorusConfig } from "./types.js";
import {
  ROUND_1_CHORUS_INSTRUCTION,
  ROUND_N_CHORUS_INSTRUCTION,
  CURATION_PROMPT,
  HARVEST_PROMPT,
  roundHorizonParts,
  criticMaxRoundsRule,
  modelFooter,
} from "./prompts.js";
import { withTimeout, estimateTokens } from "../types.js";

const SESSION_CONTEXT_LIMIT = 60_000;
const PROMPT_BUDGET_PER_ROUND = 4000;

function extractJSON(text: string): Record<string, unknown> | null {
  // Strip markdown fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    // Try the first balanced-looking object
    for (const m of candidate.matchAll(/\{[\s\S]*?\}/g)) {
      try {
        return JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    return null;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

async function deleteSessionSafely(
  client: OpencodeClient,
  id: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await client.session.delete({ path: { id } });
      if (!res.error) return;
      if (attempt === 3) {
        console.error(`[chorus] FAILED to delete session ${id} after 3 attempts: ${JSON.stringify(res.error)}`);
      }
    } catch (e) {
      if (attempt === 3) {
        console.error(`[chorus] FAILED to delete session ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
}

// ── Spawn one brainstormer ─────────────────────────────────────────────────

async function spawnBrainstormer(
  client: OpencodeClient,
  role: { name: string; label: string },
  prompt: string,
  config: ChorusConfig,
  directory: string,
  poolSessionId?: string,
  abortSignal?: AbortSignal,
): Promise<IdeaResponse> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= config.debaterRetries; attempt++) {
    if (abortSignal?.aborted) break; // user aborted — no more retries
    const effectivePrompt = attempt > 0
      ? `Previous response was invalid. ${prompt}\n\nReminder: 50-500 words of plain prose.`
      : prompt;

    try {
      let sessionId: string | undefined = poolSessionId;
      let createdHere = false;
      if (!sessionId) {
        const createResult = await client.session.create({ query: { directory } });
        if (createResult.error) {
          lastError = `create: ${JSON.stringify(createResult.error)}`;
          continue;
        }
        sessionId = createResult.data.id;
        createdHere = true;
      }

      try {
        const promptResult = await withTimeout(
          client.session.prompt({
            path: { id: sessionId },
            body: {
              agent: role.name,
              parts: [{ type: "text", text: effectivePrompt }],
            },
          }),
          config.perAgentTimeout,
          "brainstormer prompt",
        );

        if (promptResult.error) {
          lastError = `prompt: ${JSON.stringify(promptResult.error)}`;
          if (/abort|cancel|interrupt/i.test(lastError)) break;
          continue;
        }

        const { info, parts } = promptResult.data;

        if (info.error) {
          lastError = info.error.name ?? "message_error";
          if ((info.error.name as string) === "context_overflow") break;
          if (/abort|cancel|interrupt/i.test(lastError)) break;
          continue;
        }

        const text = (parts as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("");

        const tokens = {
          input: info.tokens?.input ?? estimateTokens(effectivePrompt),
          output: info.tokens?.output ?? estimateTokens(text),
        };

        if (tokens.output < config.debaterMinTokens) {
          lastError = `response too short (${tokens.output} tokens)`;
          continue;
        }

        return { agentName: role.name, label: role.label, text, tokens, error: null };
      } finally {
        if (createdHere) {
          await deleteSessionSafely(client, sessionId);
        }
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (/abort|cancel|interrupt/i.test(lastError)) break;
    }
  }

  return {
    agentName: role.name,
    label: role.label,
    text: "",
    tokens: { input: 0, output: 0 },
    error: lastError ?? "unknown error",
  };
}

// ── Curator (JSON scoring) ─────────────────────────────────────────────────

let curationFailure: string | null = null;

async function callCurator(
  client: OpencodeClient,
  config: ChorusConfig,
  prompt: string,
  directory: string,
  poolSessionId?: string,
): Promise<CurationOutput | null> {
  try {
    let sessionId: string | undefined = poolSessionId;
    let createdHere = false;
    if (!sessionId) {
      const createResult = await client.session.create({ query: { directory } });
      if (createResult.error) {
        curationFailure = `create: ${JSON.stringify(createResult.error).slice(0, 200)}`;
        return null;
      }
      sessionId = createResult.data.id;
      createdHere = true;
    }

    try {
      const promptResult = await withTimeout(
        client.session.prompt({
          path: { id: sessionId },
          body: {
            agent: CHORUS_CURATOR.name,
            parts: [{ type: "text", text: prompt }],
          },
        }),
        config.perAgentTimeout,
        "curator curation",
      );

      if (promptResult.error) {
        curationFailure = `provider error: ${JSON.stringify(promptResult.error).slice(0, 300)}`;
        return null;
      }
      if (promptResult.data.info.error) {
        curationFailure = `message error: ${promptResult.data.info.error.name ?? "unknown"}`;
        return null;
      }

      const text = (promptResult.data.parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");

      if (!text.trim()) {
        curationFailure = "empty response (model returned no text)";
        return null;
      }

      const json = extractJSON(text);
      if (!json) {
        curationFailure = `unparseable response: ${text.slice(0, 200)}`;
        return null;
      }

      return {
        newIdeaCount: Math.max(0, Math.round(Number(json.newIdeaCount) || 0)),
        themes: Array.isArray(json.themes)
          ? (json.themes as unknown[]).map(String).slice(0, 8)
          : [],
        gems: Array.isArray(json.gems)
          ? (json.gems as unknown[]).map(String).slice(0, 6)
          : [],
        continueDecision: json.continueDecision === "STOP" ? "STOP" : "CONTINUE",
        reasonIfStop: typeof json.reasonIfStop === "string" ? json.reasonIfStop : null,
        runningBrief: typeof json.runningBrief === "string" ? json.runningBrief : "No brief.",
        heuristicFallback: false,
      };
    } finally {
      if (createdHere) {
        await deleteSessionSafely(client, sessionId);
      }
    }
  } catch {
    curationFailure = "exception in curator call";
    return null;
  }
}

/** Heuristic fallback when the curator model fails: estimate new ideas by
 *  counting distinct-ish sentences; themes from labels. */
function heuristicCuration(ctx: { round: number; responses: IdeaResponse[] }): CurationOutput {
  let ideas = 0;
  for (const r of ctx.responses) {
    if (r.error) continue;
    const sentences = r.text.split(/[.!?]+/).filter((s) => s.trim().length > 40);
    ideas += Math.min(sentences.length, 4);
  }
  return {
    newIdeaCount: ideas,
    themes: ctx.responses.filter((r) => !r.error).map((r) => r.label),
    gems: [],
    continueDecision: "CONTINUE",
    reasonIfStop: null,
    runningBrief: `Heuristic curation (curator model unavailable: ${curationFailure ?? "unknown"}). Rough idea count: ${ideas}.`,
    heuristicFallback: true,
  };
}

// ── Round loop ─────────────────────────────────────────────────────────────

export async function runChorus(
  client: OpencodeClient,
  query: string,
  config: ChorusConfig,
  directory: string,
  abortSignal?: AbortSignal,
): Promise<ChorusResult> {
  const session = createChorusSession(query);
  session.status = "deliberating";

  const sessionPool: Record<string, string> = {};
  const ownedSessions: string[] = [];
  const abortFlag = { value: false };

  const onAbort = (): void => {
    abortFlag.value = true;
    if (session.status === "deliberating") session.status = "aborted";
    for (const id of ownedSessions) {
      try { void client.session.abort({ path: { id } }).catch(() => {}); } catch { /* best-effort */ }
    }
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    // Create the session pool (one per brainstormer + curator)
    for (const role of CHORUS_ROLES) {
      try {
        const res = await client.session.create({ query: { directory } });
        if (res.data?.id) {
          sessionPool[role.name] = res.data.id;
          ownedSessions.push(res.data.id);
        }
      } catch { /* best-effort */ }
    }
    try {
      const res = await client.session.create({ query: { directory } });
      if (res.data?.id) {
        sessionPool[CHORUS_CURATOR.name] = res.data.id;
        ownedSessions.push(res.data.id);
      }
    } catch { /* best-effort */ }

    const sessionTokens = new Map<string, number>();

    while (session.status === "deliberating") {
      if (abortFlag.value) break;
      session.round++;

      const { roundSuffix, noLimitNote } = roundHorizonParts(config.hideRoundLimit, config.maxRounds);

      const responses = await Promise.all(
        CHORUS_ROLES.map((role) => {
          const prompt =
            session.round === 1 || session.rounds.length === 0
              ? ROUND_1_CHORUS_INSTRUCTION.replaceAll("{{query}}", query)
              : (() => {
                  const last = session.rounds[session.rounds.length - 1];
                  const others = last.responses.filter((r) => r.agentName !== role.name);
                  const shuffled = [...others];
                  for (let i = shuffled.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                  }
                  const transcript = shuffled
                    .map((r) => `### ${r.label} (${r.error ? `⚠️ FAILED: ${r.error}` : "responded"})\n${r.text}`)
                    .join("\n\n");
                  return ROUND_N_CHORUS_INSTRUCTION
                    .replaceAll("{{round}}", String(session.round))
                    .replaceAll("{{noLimitNote}}", noLimitNote)
                    .replaceAll("{{roundTranscript}}", transcript)
                    .replaceAll("{{runningBrief}}", session.runningBrief || "(none yet)");
                })();
          return spawnBrainstormer(
            client,
            role,
            prompt,
            config,
            directory,
            sessionPool[role.name],
            abortSignal,
          );
        }),
      );

      const roundRecord: ChorusRound = { round: session.round, responses, curation: null };
      session.rounds.push(roundRecord);

      // Abort arrived mid-round
      if (abortFlag.value) {
        session.status = "aborted";
        roundRecord.curation = {
          newIdeaCount: 0,
          themes: [],
          gems: [],
          continueDecision: "STOP",
          reasonIfStop: "aborted_by_user",
          runningBrief: "The brainstorming session was aborted by the user.",
          heuristicFallback: true,
        };
        break;
      }

      const activeCount = responses.filter((r) => !r.error).length;
      if (activeCount < 2) {
        session.status = "completed";
        roundRecord.curation = {
          newIdeaCount: 0,
          themes: [],
          gems: [],
          continueDecision: "STOP",
          reasonIfStop: "insufficient_participants",
          runningBrief: "Too few participants remained active.",
          heuristicFallback: true,
        };
        break;
      }

      // Curator curation
      curationFailure = null;
      const transcript = responses
        .map((r) => `### ${r.label} (${r.error ? `⚠️ FAILED: ${r.error}` : "responded"})\n${r.text}`)
        .join("\n\n");

      const curationPrompt = CURATION_PROMPT
        .replaceAll("{{round}}", String(session.round))
        .replaceAll("{{query}}", query)
        .replaceAll("{{noLimitNote}}", noLimitNote)
        .replaceAll("{{themeHistory}}", JSON.stringify(session.themeHistory))
        .replaceAll("{{roundTranscript}}", transcript)
        .replaceAll("{{maxRoundsRule}}", criticMaxRoundsRule(config.hideRoundLimit || config.maxRounds === null));

      let curation = await callCurator(client, config, curationPrompt, directory, sessionPool[CHORUS_CURATOR.name]);
      if (!curation && !abortFlag.value) {
        const retryPrompt = `${curationPrompt}\n\n---\nREMINDER: Respond with VALID JSON ONLY matching the schema from your system prompt.`;
        curation = await callCurator(client, config, retryPrompt, directory, sessionPool[CHORUS_CURATOR.name]);
      }
      if (!curation) {
        if (abortFlag.value) {
          session.status = "aborted";
          roundRecord.curation = {
            newIdeaCount: 0,
            themes: [],
            gems: [],
            continueDecision: "STOP",
            reasonIfStop: "aborted_by_user",
            runningBrief: "The brainstorming session was aborted by the user.",
            heuristicFallback: true,
          };
          break;
        }
        console.error(
          `[chorus] CURATOR FAILED for round ${session.round} — heuristic fallback used. Reason: ${curationFailure ?? "unknown"}.`,
        );
        curation = heuristicCuration({ round: session.round, responses });
      }

      roundRecord.curation = curation;
      session.runningBrief = curation.runningBrief;
      if (curation.themes.length > 0) {
        session.themeHistory.push(...curation.themes);
      }

      // Context guard — deterministic per-session estimate
      const roundOutput = responses.reduce((sum, r) => sum + (r.error ? 0 : r.tokens.output), 0);
      const curatorEst = (sessionTokens.get("curator") ?? 0) + PROMPT_BUDGET_PER_ROUND + roundOutput;
      sessionTokens.set("curator", curatorEst);
      let overLimit = curatorEst > SESSION_CONTEXT_LIMIT;
      for (const r of responses) {
        if (r.error) continue;
        const est = (sessionTokens.get(r.agentName) ?? 0) + PROMPT_BUDGET_PER_ROUND + r.tokens.output;
        sessionTokens.set(r.agentName, est);
        if (est > SESSION_CONTEXT_LIMIT) overLimit = true;
      }

      // Stopping conditions
      if (session.status !== "deliberating") break;
      if (curation.continueDecision === "STOP" || curation.newIdeaCount < config.minNewIdeas) {
        // Plateau: idea generation has run dry (machine gate on newIdeaCount)
        session.status = "completed";
        roundRecord.curation = {
          ...curation,
          continueDecision: "STOP",
          reasonIfStop: curation.newIdeaCount < config.minNewIdeas
            ? `plateau (only ${curation.newIdeaCount} new idea(s) this round)`
            : (curation.reasonIfStop ?? "curator decided"),
        };
        break;
      }
      if (config.maxRounds !== null && session.round >= config.maxRounds) {
        session.status = "completed";
        roundRecord.curation = { ...curation, reasonIfStop: "max_rounds" };
        break;
      }
      if (config.maxRounds === null && session.round >= SAFETY_CAP_ROUNDS) {
        session.status = "completed";
        roundRecord.curation = { ...curation, reasonIfStop: "max_rounds" };
        break;
      }
      if (overLimit) {
        session.status = "completed";
        roundRecord.curation = { ...curation, reasonIfStop: "context_pressure" };
        break;
      }
    }

    // ── Harvest (skipped on abort — no token burn) ───────────────────────
    let harvest: string;
    if (session.status === "aborted") {
      harvest = `## Brainstorm Aborted\n\nThe session was aborted by the user after ${session.round} round(s). All sessions were cleaned up.`;
    } else {
      const lastCuration = session.rounds.length > 0
        ? session.rounds[session.rounds.length - 1].curation
        : null;
      const stopReason = lastCuration?.reasonIfStop ?? "unknown";
      const totalIdeas = session.rounds.reduce(
        (sum, r) => sum + (r.curation?.newIdeaCount ?? 0),
        0,
      );

      const harvestPrompt = HARVEST_PROMPT
        .replaceAll("{{stopReason}}", stopReason)
        .replaceAll("{{roundsRun}}", String(session.round));

      const curatorSession = sessionPool[CHORUS_CURATOR.name];
      let harvestText: string | null = null;
      if (curatorSession) {
        try {
          const res = await withTimeout(
            client.session.prompt({
              path: { id: curatorSession },
              body: {
                agent: CHORUS_CURATOR.name,
                parts: [{ type: "text", text: harvestPrompt }],
              },
            }),
            config.perAgentTimeout,
            "curator harvest",
          );
          if (!res.error && !res.data.info.error) {
            harvestText = (res.data.parts as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("");
          }
        } catch { /* fall through */ }
      }

      if (!harvestText || !harvestText.trim()) {
        // Fallback: build a compact harvest from what we have
        const lines = session.rounds.flatMap((r) =>
          r.responses
            .filter((resp) => !resp.error)
            .map((resp) => `- **${resp.label} (Round ${r.round}):** ${resp.text.slice(0, 300)}${resp.text.length > 300 ? "…" : ""}`),
        );
        harvestText = [
          `## Idea Harvest`,
          ``,
          `**Topic:** ${query}`,
          ``,
          `### Raw contributions${session.rounds.some((r) => r.curation?.heuristicFallback) ? " (curator model unavailable — uncurated)" : ""}`,
          ...lines,
        ].join("\n");
      }

      const models: Record<string, string> = {};
      for (const role of [...CHORUS_ROLES, CHORUS_CURATOR]) {
        models[role.label] = config.curatorModel && role === CHORUS_CURATOR
          ? config.curatorModel
          : (config.debaterModel ?? "(session default)");
      }

      harvest = `${harvestText}\n\n---\n*Brainstorm ran ${session.round} round(s) in ${((Date.now() - session.startTime) / 1000).toFixed(1)}s · ${totalIdeas} ideas captured · stop: ${stopReason}*${modelFooter(models)}`;
    }

    return { session, harvest, elapsedMs: Date.now() - session.startTime };
  } finally {
    for (const id of ownedSessions) {
      await deleteSessionSafely(client, id);
    }
  }
}

// ── Tool handler ───────────────────────────────────────────────────────────

export async function handleChorus(
  client: OpencodeClient,
  config: ChorusConfig,
  args: ChorusArgs,
  directory: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const effectiveConfig: ChorusConfig = { ...config };
  if (args.maxRounds !== undefined) effectiveConfig.maxRounds = args.maxRounds;
  if (args.hideLimit !== undefined) effectiveConfig.hideRoundLimit = args.hideLimit;
  if (args.debug !== undefined) effectiveConfig.debug = args.debug;

  const startNote = `[chorus] Brainstorming: "${args.query.slice(0, 100)}${args.query.length > 100 ? "…" : ""}"\n`;

  try {
    const result = await runChorus(client, args.query, effectiveConfig, directory, abortSignal);
    return `${startNote}${result.harvest}`;
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    return `${startNote}## Brainstorm Failed\n\nSession failed: ${error}`;
  }
}
