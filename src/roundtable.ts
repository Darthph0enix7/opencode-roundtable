// opencode-roundtable — Public tool handler + result formatting

import type { OpencodeClient } from "@opencode-ai/sdk";
import type { RoundtableConfig } from "./types.js";
import { runLoop, type LoopResult } from "./loop.js";

export interface RoundtableArgs {
  query: string;
  maxRounds?: number;
  debug?: boolean;
}

export async function handleRoundtable(
  client: OpencodeClient,
  config: RoundtableConfig,
  args: RoundtableArgs,
  directory: string,
): Promise<string> {
  const effectiveConfig: RoundtableConfig = { ...config };
  if (args.maxRounds !== undefined) effectiveConfig.maxRounds = args.maxRounds;
  if (args.debug !== undefined) effectiveConfig.debug = args.debug;

  const startNote = `[roundtable] Running multi-agent debate on: "${args.query.slice(0, 100)}${args.query.length > 100 ? "…" : ""}"\n`;
  let output = startNote;

  try {
    const result = await runLoop(client, args.query, effectiveConfig, directory);
    output += formatResult(result, effectiveConfig.debug);
    return output;
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    return `${output}## Council Decision\n\nDebate failed: ${error}`;
  }
}

function formatResult(result: LoopResult, debug: boolean): string {
  const { state, synthesis, elapsedMs } = result;
  const elapsed = (elapsedMs / 1000).toFixed(1);

  let out = `\n[roundtable] Complete — ${state.round} round(s) in ${elapsed}s\n\n`;
  out += synthesis;
  out += `\n\n---\n*Debate ran ${state.round} round(s) in ${elapsed}s.*`;

  if (debug) {
    out += `\n\n## Debug: Full Debate State\n`;
    out += `\`\`\`json\n`;
    out += JSON.stringify({
      query: state.query,
      round: state.round,
      status: state.status,
      consensusHistory: state.consensusHistory,
      qualityHistory: state.qualityHistory,
      rounds: state.rounds.map(r => ({
        round: r.round,
        critic: r.critic ? {
          consensusScore: r.critic.consensusScore,
          qualityScore: r.critic.qualityScore,
          continueDecision: r.critic.continueDecision,
          reasonIfStop: r.critic.reasonIfStop,
          heuristicFallback: r.critic.heuristicFallback,
        } : null,
        debaters: r.responses.map(d => ({
          name: d.label,
          tokens: d.tokens,
          error: d.error,
          preview: d.text.slice(0, 200),
        })),
      })),
    }, null, 2);
    out += `\n\`\`\``;
  }

  return out;
}
