import { isAllowedToolChoice, type OcxParsedRequest, type OcxProviderConfig, type OcxToolChoice } from "../types";

const LINUX_MCP_GATEWAY_TOOL_NAME = "mcp__linux_mcp__workspace";
const EXEC_NESTED_TOOL_CATALOG_NAME = "ALL_TOOLS";
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

function containsLinuxMcpCapabilitySignal(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") {
    if (value.includes(LINUX_MCP_GATEWAY_TOOL_NAME)) return true;
    return /\bALL_TOOLS\b[\s\S]{0,160}\b(?:catalog|metadata|nested tools?)\b/i.test(value)
      || /\b(?:catalog|metadata|nested tools?)\b[\s\S]{0,160}\bALL_TOOLS\b/i.test(value);
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, nested]) => key === EXEC_NESTED_TOOL_CATALOG_NAME
    || containsLinuxMcpCapabilitySignal(nested, seen));
}

function isDeclaredLinuxMcpGateway(spec: unknown): boolean {
  if (!isRecord(spec)) return false;
  if (spec.name === LINUX_MCP_GATEWAY_TOOL_NAME) return true;
  if (spec.type !== "namespace" || spec.name !== "mcp__linux_mcp" || !Array.isArray(spec.tools)) return false;
  return spec.tools.some(tool => isRecord(tool) && tool.name === "workspace");
}

function rawRequestToolSpecs(parsed: OcxParsedRequest): unknown[] {
  if (!isRecord(parsed._rawBody)) return [];
  const specs = Array.isArray(parsed._rawBody.tools) ? [...parsed._rawBody.tools] : [];
  if (!Array.isArray(parsed._rawBody.input)) return specs;
  for (const item of parsed._rawBody.input) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) specs.push(...item.tools);
  }
  return specs;
}

/**
 * A generic custom/freeform exec tool is not proof that its nested runtime owns Linux MCP. Use the
 * raw request because the parser intentionally drops custom-tool format/metadata. Exec must expose
 * its ALL_TOOLS nested catalog or name the gateway in its description/format/metadata (the real
 * Codex contract), or the gateway must be explicitly declared in the request tool manifest.
 * System/developer prompt text is ignored.
 */
function hasLinuxMcpGatewayCapability(parsed: OcxParsedRequest): boolean {
  const specs = rawRequestToolSpecs(parsed);
  return specs.some(spec => isRecord(spec)
    && spec.type === "custom"
    && spec.name === "exec"
    && containsLinuxMcpCapabilitySignal(spec))
    || specs.some(isDeclaredLinuxMcpGateway);
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
 * Prefer the nested Linux MCP gateway only for routed, non-OpenAI providers and only when the
 * custom/freeform unified exec tool is actually available. The availability guard is the recovery
 * path: if exec disappears on a later turn, native tools and the original prompt remain untouched.
 */
export function applyLinuxMcpEnforcement(
  parsed: OcxParsedRequest,
  route: LinuxMcpRouteIdentity,
  enabled = true,
): LinuxMcpEnforcementResult {
  const tools = parsed.context.tools ?? [];
  const hasUnifiedExec = tools.some(tool => !tool.namespace && tool.name === "exec" && tool.freeform === true);
  if (!enabled || isNativeOpenAIRoute(route) || !hasUnifiedExec || !hasLinuxMcpGatewayCapability(parsed)) {
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
