import { getDefaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import {
  applyLinuxMcpEnforcement,
  LINUX_MCP_SYSTEM_INSTRUCTION,
} from "../src/server/linux-mcp-enforcement";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";
import realCodexToolSpec from "./fixtures/codex-0.144.6-tool-spec.sanitized.json";

const custom = (name: string) => ({ type: "custom", name, description: `${name} tool` });
const linuxExec = () => ({
  type: "custom",
  name: "exec",
  description: "Run JavaScript with nested tools, including tools.mcp__linux_mcp__workspace.",
  format: { type: "grammar", syntax: "lark", definition: "start: /[\\s\\S]+/" },
});
const capturedExec = () => structuredClone(realCodexToolSpec.request.tools[0]);
const fn = (name: string) => ({ type: "function", name, description: `${name} tool`, parameters: { type: "object" } });
const route = (providerName: string, adapter = "openai-chat", baseUrl = "https://example.test/v1", modelId = "model-x") => ({
  providerName,
  modelId,
  provider: { adapter, baseUrl },
});

describe("Linux MCP enforcement for routed models", () => {
  test("defaults on for the current system", () => {
    expect(getDefaultConfig().enforceLinuxMcp).toBe(true);
  });

  test("filters native competitors and injects the nested exec contract into both request shapes", () => {
    const parsed = parseRequest({
      model: "umans/umans-kimi-k2.7",
      instructions: "existing system instruction",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "inspect the repo" }] },
        { type: "additional_tools", role: "user", tools: [fn("glob"), { type: "tool_search" }, fn("keep_loaded")] },
      ],
      tools: [
        linuxExec(),
        custom("apply_patch"),
        fn("exec_command"),
        fn("read_file"),
        fn("grep"),
        { type: "tool_search", description: "deferred discovery" },
        { type: "namespace", name: "mcp__fs", tools: [fn("read_file")] },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "function", name: "exec_command" },
          { type: "function", name: "read_file" },
          { type: "tool_search" },
          { type: "custom", name: "apply_patch" },
        ],
      },
    });

    const result = applyLinuxMcpEnforcement(parsed, route("umans"));

    expect(result).toEqual({ applied: true, removedToolNames: ["exec_command", "read_file", "grep", "tool_search", "glob"] });
    expect(parsed.context.tools?.map(tool => [tool.namespace, tool.name])).toEqual([
      [undefined, "exec"],
      [undefined, "apply_patch"],
      ["mcp__fs", "read_file"],
      [undefined, "keep_loaded"],
    ]);
    expect(parsed.options.toolChoice).toEqual({ allowedTools: ["exec", "apply_patch"], mode: "required" });
    expect(parsed.context.systemPrompt).toContain(LINUX_MCP_SYSTEM_INSTRUCTION);
    expect(LINUX_MCP_SYSTEM_INSTRUCTION).toContain("exec.ALL_TOOLS");
    expect(LINUX_MCP_SYSTEM_INSTRUCTION).toContain("tools.mcp__linux_mcp__workspace");
    expect(LINUX_MCP_SYSTEM_INSTRUCTION).toContain("Do not use `tool_search`");

    const raw = parsed._rawBody as Record<string, unknown>;
    const rawTools = raw.tools as Array<{ type?: string; name?: string }>;
    expect(rawTools.map(tool => tool.name).filter(Boolean)).toEqual(["exec", "apply_patch", "mcp__fs"]);
    expect(rawTools.some(tool => tool.type === "tool_search")).toBe(false);
    const additional = (raw.input as Array<{ type?: string; tools?: Array<{ name?: string }> }>).find(item => item.type === "additional_tools");
    expect(additional?.tools?.map(tool => tool.name)).toEqual(["keep_loaded"]);
    expect(raw.instructions).toBe(`existing system instruction\n\n${LINUX_MCP_SYSTEM_INSTRUCTION}`);
    expect(raw.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "custom", name: "exec" }, { type: "custom", name: "apply_patch" }],
    });
  });

  test("keeps the native catalog as recovery when unified exec is unavailable", () => {
    const parsed = parseRequest({
      model: "umans/umans-kimi-k2.7",
      instructions: "original",
      input: "inspect",
      tools: [fn("exec_command"), fn("read_file"), fn("grep"), fn("glob"), { type: "tool_search" }],
    });
    const originalRaw = JSON.stringify(parsed._rawBody);

    expect(applyLinuxMcpEnforcement(parsed, route("umans"))).toEqual({
      applied: false,
      removedToolNames: [],
    });
    expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["exec_command", "read_file", "grep", "glob", "tool_search"]);
    expect(parsed.context.systemPrompt).toEqual(["original"]);
    expect(JSON.stringify(parsed._rawBody)).toBe(originalRaw);
    expect(((parsed._rawBody as { tools: Array<{ type?: string }> }).tools).some(tool => tool.type === "tool_search")).toBe(true);
  });

  test("accepts the sanitized real Codex exec spec without relying on description capability text", () => {
    expect(realCodexToolSpec.capture.execDescriptionContainsAllTools).toBe(false);
    expect(realCodexToolSpec.capture.execDescriptionContainsLinuxMcpGateway).toBe(false);
    const parsed = parseRequest(structuredClone(realCodexToolSpec.request));

    expect(applyLinuxMcpEnforcement(parsed, route("deepseek", "openai-chat", "https://api.deepseek.com", "deepseek-v4-pro"))).toEqual({
      applied: true,
      removedToolNames: ["exec_command", "read_file", "search_files", "tool_search"],
    });
    expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["exec"]);
  });

  test("keeps the native catalog when exec is not the custom freeform surface", () => {
    const parsed = parseRequest({
      model: "deepseek/deepseek-v4-pro",
      input: "inspect",
      tools: [fn("exec"), fn("exec_command"), fn("read_file"), { type: "tool_search" }],
    });
    const originalRaw = JSON.stringify(parsed._rawBody);

    expect(applyLinuxMcpEnforcement(parsed, route("deepseek"))).toEqual({ applied: false, removedToolNames: [] });
    expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["exec", "exec_command", "read_file", "tool_search"]);
    expect(JSON.stringify(parsed._rawBody)).toBe(originalRaw);
  });

  test("uses route identity instead of hostname for OpenAI Responses, Azure OpenAI, and routed chat providers", () => {
    const identities = [
      [route("azure-enterprise", "azure-openai", "https://llm.corp.example/openai", "deployment-a"), false],
      [route("openai", "openai-chat", "https://gateway.corp.example/v1", "gpt-5.5"), false],
      [route("openai-apikey", "openai-chat", "https://gateway.corp.example/v1", "gpt-5.5"), false],
      [route("custom-responses", "openai-responses", "https://gateway.corp.example/v1", "gpt-5.5"), false],
      [route("deepseek", "openai-chat", "https://api.deepseek.com", "deepseek-v4-pro"), true],
      [route("openrouter", "openai-chat", "https://api.openai.com/v1", "openai/gpt-5.5"), true],
      [route("opencode-go", "openai-chat", "https://opencode.ai/zen/go/v1", "deepseek-v4-pro"), true],
    ] as const;

    for (const [identity, shouldApply] of identities) {
      const parsed = parseRequest({ model: "test", input: "inspect", tools: [linuxExec(), fn("exec_command")] });
      expect(applyLinuxMcpEnforcement(parsed, identity).applied).toBe(shouldApply);
      expect(parsed.context.tools?.map(tool => tool.name)).toEqual(shouldApply ? ["exec"] : ["exec", "exec_command"]);
    }
  });

  test("does not alter an explicit opt-out request", () => {
    for (const enabled of [false] as const) {
      const parsed = parseRequest({ model: "test", input: "inspect", tools: [linuxExec(), fn("exec_command")] });
      expect(applyLinuxMcpEnforcement(parsed, route("deepseek"), enabled).applied).toBe(false);
      expect(parsed.context.tools?.map(tool => tool.name)).toEqual(["exec", "exec_command"]);
    }
  });

  test("server routing sends a filtered catalog and system contract to a non-OpenAI chat provider", async () => {
    const config: OcxConfig = {
      port: 10100,
      providers: {
        custom: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          authMode: "key",
          apiKey: "test-key",
        },
      },
      defaultProvider: "custom",
      enforceLinuxMcp: true,
    };
    const originalFetch = globalThis.fetch;
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "model-x",
        choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { "content-type": "application/json" } });
    };

    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "custom/model-x",
          input: "inspect",
          stream: false,
          tools: [capturedExec(), custom("apply_patch"), fn("exec_command"), fn("read_file"), fn("grep"), fn("glob"), { type: "tool_search" }],
        }),
      }), config, { model: "", provider: "" });

      expect(response.status).toBe(200);
      const upstreamTools = upstreamBody?.tools as Array<{ function?: { name?: string } }>;
      expect(upstreamTools.map(tool => tool.function?.name)).toEqual(["exec", "apply_patch"]);
      const upstreamMessages = upstreamBody?.messages as Array<{ role?: string; content?: string }>;
      expect(upstreamMessages.find(message => message.role === "system")?.content).toContain("exec.ALL_TOOLS");
      expect(upstreamMessages.find(message => message.role === "system")?.content).toContain("tools.mcp__linux_mcp__workspace");
      expect(upstreamMessages.find(message => message.role === "system")?.content).toContain("tools.exec_command");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
