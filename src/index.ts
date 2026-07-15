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
import { loadConfig, DEBATERS, PLUGIN_ID, PLUGIN_VERSION, type RoundtableConfig } from "./types.js";
import {
  ROUNDTABLE_AGENT_PROMPT,
  SKEPTIC_SYSTEM,
  PRAGMATIST_SYSTEM,
  ARCHITECT_SYSTEM,
  CRITIC_SYSTEM,
} from "./prompts.js";
import { handleRoundtable } from "./roundtable.js";
import { z } from "zod";

// ── Auto-Updater ────────────────────────────────────────────────────────────

function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

async function runAutoUpdate(client: OpencodeClient, $: any) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PLUGIN_ID}/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000), // 5s timeout
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version: string };
    const latestVersion = data.version;

    if (latestVersion && isNewer(latestVersion, PLUGIN_VERSION)) {
      client.tui.showToast({
        body: {
          title: "Roundtable Update",
          message: `Auto-updating to v${latestVersion} in background...`,
          variant: "info",
          duration: 3000,
        },
      }).catch(() => {});

      // Use OpenCode's own CLI to force update the plugin cache
      await $`opencode plugin ${PLUGIN_ID} -f`.quiet();

      client.tui.showToast({
        body: {
          title: "Roundtable Updated!",
          message: `v${latestVersion} installed successfully. Restart OpenCode to apply.`,
          variant: "success",
          duration: 8000,
        },
      }).catch(() => {});
    }
  } catch (err) {
    // Fail silently in background
  }
}

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

  // Fire and forget auto-updater
  runAutoUpdate(client, input.$).catch(() => {});

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

  return {
    tool: {
      roundtable: roundtableTool,
    },

    async config(cfg: Record<string, unknown>) {
      const agentConfig = (cfg.agent ?? {}) as Record<string, unknown>;

      // Primary orchestrator agent — gets the roundtable tool + can spawn subagents
      agentConfig["roundtable"] = {
        mode: "primary",
        description: `Multi-agent roundtable debate orchestrator (${DEBATERS.map((d) => d.label).join(", ")} + Critic). Call the roundtable tool to start a debate.`,
        prompt: ROUNDTABLE_AGENT_PROMPT,
        color: "#7C3AED",
        tools: { roundtable: true },
      };

      // Debater subagents — each carries its own epistemic system prompt + research tools
      for (const def of DEBATERS) {
        agentConfig[def.name] = {
          mode: "subagent",
          description: def.epistemicRole,
          prompt: debaterPrompts[def.name],
          tools: debaterTools,
        };
      }

      // Critic / chair subagent — judges consensus and synthesizes the final report
      agentConfig["roundtable-critic"] = {
        mode: "subagent",
        description: "Debate critic — scores consensus, decides continue/stop, synthesizes final report",
        prompt: CRITIC_SYSTEM,
        tools: criticTools,
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
