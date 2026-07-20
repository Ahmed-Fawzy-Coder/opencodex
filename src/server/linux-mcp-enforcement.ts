import { isAllowedToolChoice, type OcxParsedRequest, type OcxProviderConfig, type OcxToolChoice } from "../types";

const OPENAI_PROVIDER_NAMES = new Set(["openai", "openai-apikey", "openai-multi", "chatgpt"]);

export interface LinuxMcpRouteIdentity {
  providerName: string;
  modelId: string;
  provider: Pick<OcxProviderConfig, "adapter" | "baseUrl">;
}

/**
 * Routed chat models only see the custom `exec` surface. MCP tools owned by that surface are
 * intentionally nested in exec.ALL_TOOLS and therefore are not discoverable through tool_search.
 */
export const LINUX_MCP_SYSTEM_INSTRUCTION = [
  "Linux MCP enforcement is active for local workspace operations.",
  "For local file discovery, reads, searches, shell commands, tests, and logs, use the unified `exec` tool.",
  "The complete nested tool catalog, including the Linux MCP gateway, is inside `exec.ALL_TOOLS`; invoke the gateway from `exec` JavaScript exactly as `await tools.mcp__linux_mcp__workspace({ action: \"...\", arguments: { ... } })`.",
  "Do not use `tool_search` to find `mcp__linux_mcp__workspace`; tool_search does not return tools nested in `exec.ALL_TOOLS`.",
  "Inspect `exec.ALL_TOOLS` directly if you need to confirm the nested tool, and do not substitute native file or shell tools.",
  "If `mcp__linux_mcp__workspace` is genuinely absent or still unavailable after one retry, recover through a nested fallback such as `tools.exec_command` from the same `exec.ALL_TOOLS` catalog; do not request a top-level native tool.",
  "Use `apply_patch` for file edits when it is listed.",
].join(" ");

// Flat operations that bypass the unified Linux MCP gateway. This includes tool_search because it
// cannot discover tools nested in exec.ALL_TOOLS and was the source of the original false-negative
// lookup. Namespaced MCP tools are never removed, and apply_patch remains the edit path required by
// the Codex host contract.
const BLOCKED_WHEN_ENFORCED_TOOL_NAMES = new Set([
  "bash",
  "exec_command",
  "glob",
  "grep",
  "list_files",
  "ls",
  "read_file",
  "read_multiple_files",
  "run_command",
  "run_commands_parallel",
  "search_files",
  "shell",
  "tool_search",
  "write_stdin",
]);

function isBlockedWhenEnforcedToolName(name: string): boolean {
  return BLOCKED_WHEN_ENFORCED_TOOL_NAMES.has(name.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeOpenAIRoute(route: LinuxMcpRouteIdentity): boolean {
  const providerName = route.providerName.trim().toLowerCase();
  const adapter = route.provider.adapter.trim().toLowerCase();
  return OPENAI_PROVIDER_NAMES.has(providerName)
    || adapter === "openai-responses"
    || adapter === "azure"
    || adapter === "azure-openai";
}

function filterRawToolSpecs(specs: unknown[]): unknown[] {
  return specs.filter(spec => {
    if (!isRecord(spec) || spec.type === "namespace") return true;
    if (spec.type === "tool_search") return false;
    return typeof spec.name !== "string" || !isBlockedWhenEnforcedToolName(spec.name);
  });
}

function rewriteParsedToolChoice(choice: OcxToolChoice | undefined): OcxToolChoice | undefined {
  if (!choice || typeof choice === "string") return choice;
  if (isAllowedToolChoice(choice)) {
    return {
      ...choice,
      allowedTools: [...new Set(choice.allowedTools.map(name => isBlockedWhenEnforcedToolName(name) ? "exec" : name))],
    };
  }
  return isBlockedWhenEnforcedToolName(choice.name) ? { name: "exec" } : choice;
}

function rewriteRawToolChoice(rawChoice: unknown): unknown {
  if (!isRecord(rawChoice)) return rawChoice;
  if (rawChoice.type === "allowed_tools" && Array.isArray(rawChoice.tools)) {
    const seen = new Set<string>();
    const tools = rawChoice.tools
      .map(tool => {
        if (!isRecord(tool)) return tool;
        const blocked = tool.type === "tool_search"
          || (typeof tool.name === "string" && isBlockedWhenEnforcedToolName(tool.name));
        if (!blocked) return tool;
        return { type: "custom", name: "exec" };
      })
      .filter(tool => {
        if (!isRecord(tool) || typeof tool.name !== "string") return true;
        const key = `${String(tool.type)}:${tool.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return {
      ...rawChoice,
      tools,
    };
  }
  if (rawChoice.type === "tool_search"
    || (typeof rawChoice.name === "string" && isBlockedWhenEnforcedToolName(rawChoice.name))) {
    return { type: "custom", name: "exec" };
  }
  return rawChoice;
}

function rewriteRawRequest(parsed: OcxParsedRequest): void {
  const raw = parsed._rawBody;
  if (!isRecord(raw)) return;

  if (Array.isArray(raw.tools)) raw.tools = filterRawToolSpecs(raw.tools);
  if (Array.isArray(raw.input)) {
    for (const item of raw.input) {
      if (!isRecord(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) continue;
      item.tools = filterRawToolSpecs(item.tools);
    }
  }
  if (raw.tool_choice !== undefined) raw.tool_choice = rewriteRawToolChoice(raw.tool_choice);
  raw.instructions = typeof raw.instructions === "string" && raw.instructions.length > 0
    ? `${raw.instructions}\n\n${LINUX_MCP_SYSTEM_INSTRUCTION}`
    : LINUX_MCP_SYSTEM_INSTRUCTION;
}

export interface LinuxMcpEnforcementResult {
  applied: boolean;
  removedToolNames: string[];
}

/**
 * `enforceLinuxMcp` plus Codex's custom/freeform exec surface is the capability contract. The real
 * Codex wire spec intentionally does not enumerate exec's nested ALL_TOOLS catalog, so inspecting
 * its description/grammar cannot prove or disprove that Linux MCP is registered. If exec disappears
 * on a later turn, native tools and the original prompt remain untouched as the recovery path.
 */
export function applyLinuxMcpEnforcement(
  parsed: OcxParsedRequest,
  route: LinuxMcpRouteIdentity,
  enabled = true,
): LinuxMcpEnforcementResult {
  const tools = parsed.context.tools ?? [];
  const hasUnifiedExec = tools.some(tool => !tool.namespace && tool.name === "exec" && tool.freeform === true);
  if (!enabled || isNativeOpenAIRoute(route) || !hasUnifiedExec) {
    return { applied: false, removedToolNames: [] };
  }

  const removedToolNames = tools
    .filter(tool => !tool.namespace && isBlockedWhenEnforcedToolName(tool.name))
    .map(tool => tool.name);
  const keptTools = tools.filter(tool => tool.namespace || !isBlockedWhenEnforcedToolName(tool.name));
  parsed.context.tools = keptTools.length > 0 ? keptTools : undefined;
  parsed.options.toolChoice = rewriteParsedToolChoice(parsed.options.toolChoice);
  parsed.context.systemPrompt = [...(parsed.context.systemPrompt ?? []), LINUX_MCP_SYSTEM_INSTRUCTION];
  rewriteRawRequest(parsed);

  return { applied: true, removedToolNames };
}
