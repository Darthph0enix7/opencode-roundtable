/**
 * Chorus — types, config modes, and state.
 */

export interface ChorusConfig {
  mode: "light" | "standard" | "heavy" | "free";
  /** Machine-side round cap. null = unbounded (hidden safety cap). */
  maxRounds: number | null;
  /** Hide the round horizon from all participants (anti-deadline-pacing). */
  hideRoundLimit: boolean;
  /** Minimum genuinely-new ideas per round to keep the session running. */
  minNewIdeas: number;
  perAgentTimeout: number; // ms
  debaterRetries: number;
  debaterMinTokens: number;
  debaterModel: string | null;
  curatorModel: string | null;
  debug: boolean;
  /** Give brainstormers read-only research tools. */
  enableChorusTools: boolean;
}

export const SAFETY_CAP_ROUNDS = 12;

const LIGHT: Partial<ChorusConfig> = {
  maxRounds: 3,
  minNewIdeas: 2,
  perAgentTimeout: 60_000,
  debaterRetries: 1,
};

const HEAVY: Partial<ChorusConfig> = {
  maxRounds: 7,
  minNewIdeas: 2,
  perAgentTimeout: 180_000,
  debaterRetries: 3,
};

export const DEFAULT_CHORUS_CONFIG: ChorusConfig = {
  mode: "standard",
  maxRounds: 5,
  hideRoundLimit: false,
  minNewIdeas: 2,
  perAgentTimeout: 120_000,
  debaterRetries: 2,
  debaterMinTokens: 50,
  debaterModel: null,
  curatorModel: null,
  debug: false,
  enableChorusTools: true,
};

const MODE_PRESETS: Record<string, Partial<ChorusConfig>> = {
  light: LIGHT,
  heavy: HEAVY,
  free: {
    maxRounds: null,
    hideRoundLimit: true,
    minNewIdeas: 2,
  },
};

export function loadChorusConfig(opts: Record<string, unknown>): ChorusConfig {
  const merged: ChorusConfig = { ...DEFAULT_CHORUS_CONFIG };
  const mode = typeof opts.mode === "string" ? opts.mode : undefined;
  if (mode && MODE_PRESETS[mode]) {
    Object.assign(merged, MODE_PRESETS[mode]);
    merged.mode = mode as ChorusConfig["mode"];
  }
  for (const key of Object.keys(DEFAULT_CHORUS_CONFIG) as (keyof ChorusConfig)[]) {
    if (key in opts && opts[key] !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = opts[key];
    }
  }
  return merged;
}

// ── Participants ───────────────────────────────────────────────────────────

export interface ChorusRole {
  name: string; // agent name, e.g. "chorus-visionary"
  label: string; // display label, e.g. "Visionary"
  epistemicRole: string; // one-line description
  systemPrompt: string;
}

export const CHORUS_ROLES: ChorusRole[] = [
  {
    name: "chorus-visionary",
    label: "Visionary",
    epistemicRole: "Imagines what the thing could become — moonshots, what-if directions, 2-3 year horizons",
    systemPrompt: VISIONARY_SYSTEM,
  },
  {
    name: "chorus-experiencer",
    label: "Experiencer",
    epistemicRole: "Lives in the user's daily moments — ideas as felt experience",
    systemPrompt: EXPERIENCER_SYSTEM,
  },
  {
    name: "chorus-integrator",
    label: "Integrator",
    epistemicRole: "Knows what today's stack enables — buildable directions, integrations, effort tags",
    systemPrompt: INTEGRATOR_SYSTEM,
  },
];

export const CHORUS_CURATOR: ChorusRole = {
  name: "chorus-curator",
  label: "Curator",
  epistemicRole: "Chair — dedupes, groups themes, spots gems, detects plateau, writes the harvest",
  systemPrompt: CURATOR_SYSTEM,
};

// ── Round / session state ──────────────────────────────────────────────────

export interface IdeaResponse {
  agentName: string;
  label: string;
  text: string;
  tokens: { input: number; output: number };
  error: string | null;
}

export interface CurationOutput {
  newIdeaCount: number;
  themes: string[];
  gems: string[];
  continueDecision: "CONTINUE" | "STOP";
  reasonIfStop: string | null;
  runningBrief: string;
  heuristicFallback: boolean;
}

export interface ChorusRound {
  round: number;
  responses: IdeaResponse[];
  curation: CurationOutput | null;
}

export interface ChorusSession {
  query: string;
  round: number;
  status: "init" | "deliberating" | "completed" | "aborted" | "failed";
  rounds: ChorusRound[];
  runningBrief: string;
  themeHistory: string[];
  startTime: number;
}

export function createChorusSession(query: string): ChorusSession {
  return {
    query,
    round: 0,
    status: "init",
    rounds: [],
    runningBrief: "",
    themeHistory: [],
    startTime: Date.now(),
  };
}

export interface ChorusResult {
  session: ChorusSession;
  harvest: string;
  elapsedMs: number;
}

export interface ChorusArgs {
  query: string;
  maxRounds?: number | null;
  hideLimit?: boolean;
  debug?: boolean;
}

import {
  VISIONARY_SYSTEM,
  EXPERIENCER_SYSTEM,
  INTEGRATOR_SYSTEM,
  CURATOR_SYSTEM,
} from "./prompts.js";
