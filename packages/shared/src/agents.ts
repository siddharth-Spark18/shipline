// Agents a workflow stage can name: the ones bundled in the Shipline plugin, and custom agents that
// org admins define in Admin. Shipline Local hands custom agents to `claude` with `--agents`.

export interface PluginAgentDTO {
  name: string;
  description: string;
}

/**
 * The plugin's bundled agents (packages/plugin/agents/*.md).
 * OPEN-QUESTION: the hub cannot read the plugin folder at runtime, so this manifest is kept here,
 * next to the stage-agent code; update it when an agent is added to or removed from the plugin.
 */
export const PLUGIN_AGENTS: PluginAgentDTO[] = [
  { name: 'builder', description: 'Implements the plan, raises the PR with gh and fixes review comments.' },
  { name: 'planner', description: 'Writes the implementation plan. Read-only.' },
  { name: 'qa-bug-hunter', description: "Tests the change against the plan and the project's QA target; produces a QA report." },
  { name: 'researcher', description: 'Researches the problem space and the codebase. Read-only.' },
  { name: 'reviewer', description: 'Reviews the branch diff against the plan. Read-only.' },
  { name: 'wireframe-proposer', description: 'Produces wireframes as an HTML mockup or a Figma link.' },
];

export const PLUGIN_AGENT_PREFIX = 'plugin:';
export const CUSTOM_AGENT_PREFIX = 'custom:';

export const pluginAgentRef = (name: string): string => `${PLUGIN_AGENT_PREFIX}${name}`;
export const customAgentRef = (id: string): string => `${CUSTOM_AGENT_PREFIX}${id}`;

export type ParsedAgentRef = { kind: 'plugin'; name: string } | { kind: 'custom'; id: string };

export function parseAgentRef(ref: string | null | undefined): ParsedAgentRef | null {
  if (!ref) return null;
  if (ref.startsWith(PLUGIN_AGENT_PREFIX)) return { kind: 'plugin', name: ref.slice(PLUGIN_AGENT_PREFIX.length) };
  if (ref.startsWith(CUSTOM_AGENT_PREFIX)) return { kind: 'custom', id: ref.slice(CUSTOM_AGENT_PREFIX.length) };
  return null;
}

export interface CustomAgentDTO {
  id: string;
  /** Lowercase letters, digits and hyphens; how Claude addresses the agent. Fixed once created. */
  name: string;
  description: string;
  prompt: string;
  /** Tool names the agent may use (empty: inherits the session's tools). */
  tools: string[];
  /** Optional model alias or id (e.g. "sonnet"). */
  model: string | null;
}

export interface CustomAgentInput {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model: string | null;
}

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/** An error message for an agent that cannot be saved, or null when it is valid. */
export function validateAgentInput(agent: CustomAgentInput, isNew: boolean): string | null {
  if (isNew) {
    if (!AGENT_NAME_PATTERN.test(agent.name)) return 'The name must be 2-40 characters: lowercase letters, digits and hyphens, starting with a letter.';
    if (PLUGIN_AGENTS.some((a) => a.name === agent.name)) return `"${agent.name}" is the name of a bundled plugin agent.`;
  }
  if (!agent.description.trim()) return 'A description is required: Claude uses it to decide when to call the agent.';
  if (!agent.prompt.trim()) return 'A prompt is required.';
  if (agent.tools.some((t) => !t.trim() || /\s/.test(t))) return 'Tool names cannot be empty or contain spaces.';
  return null;
}

/** The JSON object `claude --agents` takes: agent name to its definition. */
export function toClaudeAgentsJson(agents: CustomAgentDTO[]): Record<string, { description: string; prompt: string; tools?: string[]; model?: string }> {
  const out: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }> = {};
  for (const a of agents) {
    out[a.name] = {
      description: a.description,
      prompt: a.prompt,
      ...(a.tools.length > 0 ? { tools: a.tools } : {}),
      ...(a.model ? { model: a.model } : {}),
    };
  }
  return out;
}
