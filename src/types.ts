// opencode-roundtable — Shared types, debate state, configuration, and helpers

import type { PluginInput, PluginOptions } from "@opencode-ai/plugin";

// ── Config ──────────────────────────────────────────────────────────────────

export interface RoundtableConfig {
  mode: "standard" | "light" | "heavy";
  maxRounds: number;
  consensusThreshold: number;
  qualityThreshold: number;
  minImprovementDelta: number;
  stalenessFloor: number;
  stalenessRounds: number;
  divergenceThreshold: number;
  perAgentTimeout: number;
  debaterMaxWords: number;
  debaterMinTokens: number;
  criticModel: string | null;
  debaterModel: string | null;
  debaterRetries: number;
  criticRetries: number;
  /// When true (default), debaters get research + execution tools (read/glob/grep/webfetch/task/bash).
  /// task lets them delegate to any available subagent for deeper research.
  enableDebaterTools: boolean;
  /// When true (default), critic gets the same tools for cross-checking claims.
  enableCriticTools: boolean;
  /// When true (default), debaters + critic can run shell commands via the bash tool.
  /// Set false to lock debate to read-only tools.
  enableBash: boolean;
  /// When true (default false), debaters + critic can write files. Off by default for safety.
  enableWrite: boolean;
  /// When true (default false), debaters + critic can edit files. Off by default for safety.
  enableEdit: boolean;
  debug: boolean;
}

export const DEFAULT_CONFIG: RoundtableConfig = {
  mode: "standard",
  maxRounds: 5,
  consensusThreshold: 0.85,
  qualityThreshold: 0.80,
  minImprovementDelta: 0.05,
  stalenessFloor: 0.02,
  stalenessRounds: 2,
  divergenceThreshold: 0.10,
  perAgentTimeout: 120_000,
  debaterMaxWords: 500,
  debaterMinTokens: 50,
  criticModel: null,
  debaterModel: null,
  debaterRetries: 2,
  criticRetries: 1,
  enableDebaterTools: true,
  enableCriticTools: true,
  enableBash: true,
  enableWrite: false,
  enableEdit: false,
  debug: false,
};

/** Light mode: fast, cheap, relaxed. Good for quick gut-checks. */
const LIGHT: Partial<RoundtableConfig> = {
  maxRounds: 3,
  consensusThreshold: 0.75,
  qualityThreshold: 0.70,
  perAgentTimeout: 60_000,
  debaterMaxWords: 350,
  debaterRetries: 1,
  criticRetries: 0,
};

/** Heavy mode: deep, thorough, expensive. Good for architectural decisions. */
const HEAVY: Partial<RoundtableConfig> = {
  maxRounds: 7,
  consensusThreshold: 0.90,
  qualityThreshold: 0.85,
  perAgentTimeout: 180_000,
  debaterMaxWords: 700,
  debaterRetries: 3,
  criticRetries: 2,
};

const MODE_PRESETS: Record<string, Partial<RoundtableConfig>> = {
  light: LIGHT,
  heavy: HEAVY,
};

/** Merge plugin options with defaults, then apply mode preset. */
export function loadConfig(raw?: PluginOptions): RoundtableConfig {
  const opts = (raw ?? {}) as Record<string, unknown>;
  const merged: RoundtableConfig = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof RoundtableConfig)[]) {
    if (key in opts) (merged as Record<string, unknown>)[key] = opts[key];
  }
  // Apply mode preset on top (user values override preset, preset overrides defaults)
  const preset = MODE_PRESETS[merged.mode];
  if (preset) {
    for (const key of Object.keys(preset) as (keyof RoundtableConfig)[]) {
      // Only override if user didn't explicitly set this key
      if (!(key in opts) && preset[key] !== undefined) {
        (merged as Record<string, unknown>)[key] = preset[key];
      }
    }
  }
  return merged;
}

// ── Debater state ───────────────────────────────────────────────────────────

export interface DebaterDef {
  name: string;          // "roundtable-skeptic" etc.
  label: string;         // "Skeptic"
  epistemicRole: string; // "Adversarial critic"
  emoji: string;         // "🔍"
}

export const DEBATERS: DebaterDef[] = [
  { name: "roundtable-skeptic",    label: "Skeptic",    epistemicRole: "Adversarial critic — finds logic holes and unstated assumptions",    emoji: "🔍" },
  { name: "roundtable-pragmatist", label: "Pragmatist", epistemicRole: "Ship-now bias — flags over-engineering and unrealistic complexity",   emoji: "⚡" },
  { name: "roundtable-architect",  label: "Architect",  epistemicRole: "Long-term shape — checks coupling, scalability, and tech debt",        emoji: "🏗️" },
];

export interface DebaterResponse {
  agentName: string;
  label: string;
  text: string;
  tokens: { input: number; output: number };
  /// null when success, error message when fail (after retries)
  error: string | null;
}

// ── Critic state ────────────────────────────────────────────────────────────

export interface CriticOutput {
  consensusScore: number;
  qualityScore: number;
  continueDecision: "STOP" | "CONTINUE";
  reasonIfStop: string | null;
  runningBrief: string;
  /// null when success, set when heuristic fallback was used
  heuristicFallback: boolean;
}

// ── Debate state ────────────────────────────────────────────────────────────

export type DebateStatus =
  | "init"
  | "deliberating"
  | "completed"
  | "failed";

export interface RoundRecord {
  round: number;
  responses: DebaterResponse[];
  critic?: CriticOutput;
}

export interface DebateState {
  query: string;
  config: RoundtableConfig;
  status: DebateStatus;
  round: number;
  activeDebaterCount: number;
  consensusHistory: number[];
  qualityHistory: number[];
  rounds: RoundRecord[];
  runningBrief: string;
  startTime: number;
}

export function createDebateState(query: string, config: RoundtableConfig): DebateState {
  return {
    query,
    config,
    status: "init",
    round: 0,
    activeDebaterCount: DEBATERS.length,
    consensusHistory: [],
    qualityHistory: [],
    rounds: [],
    runningBrief: "",
    startTime: Date.now(),
  };
}

// ── Stop decision ───────────────────────────────────────────────────────────

export interface StopDecision {
  stop: boolean;
  reason: string;
}

/** Evaluate all stopping conditions. Quorum check FIRST, then numerical conditions. */
export function evaluateStopping(state: DebateState): StopDecision {
  const { consensusHistory, qualityHistory, round, activeDebaterCount } = state;
  const cfg = state.config;

  // 6. Degenerate quorum — ALWAYS first (don't compute scores with failed agents)
  if (activeDebaterCount < 2)
    return { stop: true, reason: "insufficient_participants" };

  // 5. Max rounds — simple check, no history needed
  if (round >= cfg.maxRounds)
    return { stop: true, reason: "max_rounds" };

  // 1. Consensus threshold — needs 1+ entries
  if (consensusHistory.length >= 1 && last(consensusHistory)! >= cfg.consensusThreshold)
    return { stop: true, reason: "consensus_reached" };

  // Guard: remaining conditions need ≥3 history entries for reliable deltas
  if (consensusHistory.length < 3)
    return { stop: false, reason: "pending" };

  // 2. Quality threshold + stalled improvement
  if (last(qualityHistory)! >= cfg.qualityThreshold &&
      delta(consensusHistory, 2) < cfg.minImprovementDelta)
    return { stop: true, reason: "quality_sufficient" };

  // 3. Divergence detection
  if (delta(consensusHistory, 2) <= -cfg.divergenceThreshold)
    return { stop: true, reason: "diverging" };

  // 4. Staleness detection
  if (staleCount(consensusHistory, cfg.stalenessFloor) >= cfg.stalenessRounds)
    return { stop: true, reason: "no_improvement" };

  return { stop: false, reason: "pending" };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

/** Difference between the last value and the value `n` positions back. */
export function delta(arr: number[], n: number): number {
  if (arr.length <= n) return 0;
  return arr[arr.length - 1] - arr[arr.length - 1 - n];
}

/** Consecutive rounds where delta < floor. */
export function staleCount(arr: number[], floor: number): number {
  let count = 0;
  for (let i = arr.length - 1; i > 0; i--) {
    if (Math.abs(arr[i] - arr[i - 1]) < floor) count++;
    else break;
  }
  return count;
}

/** Estimate token count from text. Rough: 1 token ≈ 0.75 words. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

/** Plugin metadata */
export const PLUGIN_ID = "opencode-roundtable";
export const PLUGIN_VERSION = "0.1.8";
