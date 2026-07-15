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
import { loadConfig, DEBATERS, PLUGIN_ID } from "./types.js";
import {
  ROUNDTABLE_AGENT_PROMPT,
  SKEPTIC_SYSTEM,
  PRAGMATIST_SYSTEM,
  ARCHITECT_SYSTEM,
  CRITIC_SYSTEM,
} from "./prompts.js";
import { handleRoundtable } from "./roundtable.js";
import { z } from "zod";

async function server(input: PluginInput, options?: PluginOptions) {
  const client: OpencodeClient = input.client;
  const config = loadConfig(options);
  const directory = input.directory;

  const debaterPrompts: Record<string, string> = {
    "roundtable-skeptic":    SKEPTIC_SYSTEM,
    "roundtable-pragmatist": PRAGMATIST_SYSTEM,
    "roundtable-architect":  ARCHITECT_SYSTEM,
  };

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

  return {
    tool: {
      roundtable: roundtableTool,
    },

    async config(cfg: Record<string, unknown>) {
      const agentConfig = (cfg.agent ?? {}) as Record<string, unknown>;

      // Primary orchestrator agent
      agentConfig["roundtable"] = {
        mode: "primary",
        description: `Multi-agent roundtable debate orchestrator (${DEBATERS.map((d) => d.label).join(", ")} + Critic). Call the roundtable tool to start a debate.`,
        prompt: ROUNDTABLE_AGENT_PROMPT,
        color: "#7C3AED",
        tools: { roundtable: true },
      };

      // Debater subagents — each carries its own epistemic system prompt
      for (const def of DEBATERS) {
        agentConfig[def.name] = {
          mode: "subagent",
          description: def.epistemicRole,
          prompt: debaterPrompts[def.name],
        };
      }

      // Critic / chair subagent — judges consensus and synthesizes the final report
      agentConfig["roundtable-critic"] = {
        mode: "subagent",
        description: "Debate critic — scores consensus, decides continue/stop, synthesizes final report",
        prompt: CRITIC_SYSTEM,
      };

      cfg.agent = agentConfig;
    },
  };
}

const pluginModule = {
  id: PLUGIN_ID,
  server,
};

export default pluginModule;
