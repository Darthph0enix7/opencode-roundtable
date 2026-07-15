// opencode-roundtable — v2 Plugin entry point
//
// Exports { id, server } matching @opencode-ai/plugin PluginModule contract.
// Verified against magic-context v0.32.0 and SDK types from
// @opencode-ai/plugin/dist/index.d.ts.
//
// Agent registration: each role-specific system prompt is set as the agent's
// `prompt` field. OpenCode prepends it as the actual `system` message at
// inference time. Runtime spawning only sends round-specific user messages.

import type { PluginInput, PluginOptions, ToolDefinition } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { loadConfig, DEBATERS, PLUGIN_ID, type RoundtableConfig } from "./types.js";
import {
  SKEPTIC_SYSTEM,
  PRAGMATIST_SYSTEM,
  ARCHITECT_SYSTEM,
  CRITIC_SYSTEM,
} from "./prompts.js";
import { handleRoundtable } from "./roundtable.js";
import { z } from "zod";

/// Tool permissions for debate-research agents.
///
/// PERMISSION TRADE-OFF: OpenCode's `bash`, `write`, and `edit` tools
/// trigger permission prompts on every invocation — this would break
/// the "fire-and-forget debate" UX. They're disabled by default.
///
/// The research surface is `read` + `glob` + `grep` + `webfetch` +
/// `websearch` + `task` (subagent delegation). These do NOT trigger
/// permission prompts.
///
/// If you want bash/write/edit for specific debates, set
/// `enableDebaterTools` and the corresponding agents will inherit
/// your session's permission policy. Per-call reasoning for research
/// (webfetch, websearch) is always enabled regardless.
const RESEARCH_TOOLS = {
  read: true,        // read files — no permission prompt
  glob: true,        // find files by pattern — no permission prompt
  grep: true,        // search code text — no permission prompt
  webfetch: true,    // fetch any URL — no permission prompt (HTTP GET)
  websearch: true,   // run web search (no-op if not installed)
  task: true,        // delegate to subagents — no permission prompt
  // Explicitly disabled — these trigger permission prompts
  write: false,
  edit: false,
  bash: false,
  todowrite: false,
  todoread: false,
};

async function server(input: PluginInput, options?: PluginOptions) {
  const client: OpencodeClient = input.client;
  const config = loadConfig(options);
  const directory = input.directory;

  const debaterPrompts: Record<string, string> = {
    "roundtable-skeptic":    SKEPTIC_SYSTEM,
    "roundtable-pragmatist": PRAGMATIST_SYSTEM,
    "roundtable-architect":  ARCHITECT_SYSTEM,
  };

  const debaterTools = config.enableDebaterTools ? RESEARCH_TOOLS : { task: false };
  const criticTools  = config.enableCriticTools  ? RESEARCH_TOOLS : { task: false };

  const roundtableTool: ToolDefinition = {
    description: `Run a multi-agent roundtable debate on a question. Spawns ${DEBATERS.length} debaters (${DEBATERS.map((d) => d.label).join(", ")}) across multiple rounds with cross-examination and consensus scoring. Returns a synthesized council report with dissents and a model-usage footer.`,
    args: {
      query: z.string().describe("The question or topic to debate"),
      maxRounds: z.number().optional().describe(`Maximum debate rounds (default: ${config.maxRounds})`),
      debug: z.boolean().optional().describe("Include full debate state in output"),
    },
    async execute(args: Record<string, unknown>, _context: unknown) {
      return handleRoundtable(client, config, {
        query: args.query as string,
        maxRounds: args.maxRounds as number | undefined,
        debug: args.debug as boolean | undefined,
      }, directory);
    },
  };

  // Subagents only — the orchestrator (via OMO) calls the `roundtable` tool directly.
  // No primary agent needed.
  const allAgents: Record<string, unknown> = {};
  for (const def of DEBATERS) {
    allAgents[def.name] = {
      mode: "subagent",
      description: def.epistemicRole,
      prompt: debaterPrompts[def.name],
      tools: debaterTools,
    };
  }
  allAgents["roundtable-critic"] = {
    mode: "subagent",
    description: "Debate critic — scores consensus, decides continue/stop, synthesizes final report",
    prompt: CRITIC_SYSTEM,
    tools: criticTools,
  };

  return {
    // Expose `agent` at the Hooks top level — OpenChamber's Save Changes
    // handler iterates over this map to know which agents are editable.
    // (Matches the oh-my-opencode-slim pattern: returns `{ name, agent, ... }`.)
    name: PLUGIN_ID,
    agent: allAgents,

    tool: {
      roundtable: roundtableTool,
    },

    async config(cfg: Record<string, unknown>) {
      const agentConfig = (cfg.agent ?? {}) as Record<string, unknown>;
      // Merge our registered agents — existing user-defined models take priority.
      for (const [name, fullConfig] of Object.entries(allAgents)) {
        const existing = agentConfig[name];
        agentConfig[name] = {
          ...(fullConfig as Record<string, unknown>),
          ...(existing as Record<string, unknown> ?? {}),
        };
      }
      cfg.agent = agentConfig;
    },
  };
}

const pluginModule = {
  id: PLUGIN_ID,
  server,
};

export default pluginModule;
