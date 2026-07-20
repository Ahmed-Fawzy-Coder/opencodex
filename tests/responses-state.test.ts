import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  previousResponseConversationId,
  rememberResponseState,
  responseStateStatsForTests,
} from "../src/responses/state";

describe("Responses previous_response_id state", () => {
  // Sandbox OPENCODEX_HOME: the state store now snapshots to disk, and these tests must never
  // touch the real ~/.opencodex.
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];
  const priorStateBudget = process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-test-"));
    process.env["OPENCODEX_HOME"] = home;
    delete process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"];
    clearResponseStateMemoryForTests();
  });

  afterEach(() => {
    clearResponseStateForTests();
    rmSync(home, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
    if (priorStateBudget === undefined) delete process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"];
    else process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = priorStateBudget;
  });

  test("expands later input with stored prior input and output", () => {
    const firstBody = { model: "cursor/auto", input: "use ping", store: true };
    const first = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "ping" },
      { type: "tool_call_delta", arguments: "{\"value\":\"v1\"}" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "cursor/auto");
    rememberResponseState(firstBody, first);

    const expanded = expandPreviousResponseInput({
      model: "cursor/auto",
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    }) as { input: unknown[] };

    expect(expanded.input).toEqual([
      { role: "user", content: "use ping" },
      (first.output as unknown[])[0],
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
  });

  test("expanded function_call_output can be parsed with its prior tool metadata", () => {
    const firstBody = { model: "cursor/auto", input: "use ping" };
    const first = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "ping" },
      { type: "tool_call_delta", arguments: "{\"value\":\"v1\"}" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "cursor/auto");
    rememberResponseState(firstBody, first);

    const parsed = parseRequest(expandPreviousResponseInput({
      model: "cursor/auto",
      previous_response_id: first.id,
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    }));

    expect(parsed.context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "ping",
      content: "ok",
    });
  });

  test("store false prevents later expansion", () => {
    const firstBody = { model: "cursor/auto", input: "use ping", store: false };
    const first = buildResponseJSON([
      { type: "text_delta", text: "no store" },
      { type: "done" },
    ], "cursor/auto");
    rememberResponseState(firstBody, first);

    const second = {
      model: "cursor/auto",
      previous_response_id: first.id,
      input: "next",
    };

    expect(expandPreviousResponseInput(second)).toEqual(second);
  });

  test("force records despite store:false (passthrough continuation cache)", () => {
    const firstBody = { model: "gpt-5.5", input: "hello", store: false };
    const first = buildResponseJSON([
      { type: "text_delta", text: "hi there" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState(firstBody, first, undefined, { force: true });

    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: first.id,
      input: [{ role: "user", content: "next" }],
    }) as { input: unknown[] };

    expect(expanded.input).toEqual([
      { role: "user", content: "hello" },
      (first.output as unknown[])[0],
      { role: "user", content: "next" },
    ]);
  });

  test("snapshot survives a simulated restart (memory clear + disk load)", () => {
    const firstBody = { model: "gpt-5.5", input: "hello" };
    const first = buildResponseJSON([
      { type: "text_delta", text: "hi" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState(firstBody, first, "cursor_conv_9");
    flushResponseState();

    // Simulate restart: wipe memory, keep the snapshot file.
    clearResponseStateMemoryForTests();

    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: first.id,
      input: [{ role: "user", content: "next" }],
    }) as { input: unknown[] };

    expect(expanded.input).toEqual([
      { role: "user", content: "hello" },
      (first.output as unknown[])[0],
      { role: "user", content: "next" },
    ]);
    expect(previousResponseConversationId(first.id as string)).toBe("cursor_conv_9");
  });

  test("reading an entry touches its LRU position and protects it from eviction", () => {
    for (let index = 0; index < 1_000; index += 1) {
      rememberResponseState(
        { input: `input-${index}` },
        { id: `resp_lru_${index}`, output: [], status: "completed" },
      );
    }

    const touched = expandPreviousResponseInput({
      previous_response_id: "resp_lru_0",
      input: "touch",
    }) as { input: Array<{ content?: string }> };
    expect(touched.input[0]?.content).toBe("input-0");

    rememberResponseState(
      { input: "new entry" },
      { id: "resp_lru_1000", output: [], status: "completed" },
    );

    const protectedRead = expandPreviousResponseInput({
      previous_response_id: "resp_lru_0",
      input: "still present",
    }) as { input: Array<{ content?: string }> };
    expect(protectedRead.input[0]?.content).toBe("input-0");

    const evictedRead = { previous_response_id: "resp_lru_1", input: "evicted" };
    expect(expandPreviousResponseInput(evictedRead)).toEqual(evictedRead);
  });

  test("a later remember and flush persists touched LRU order across reload", () => {
    for (let index = 0; index < 1_000; index += 1) {
      rememberResponseState(
        { input: `input-${index}` },
        { id: `resp_reload_lru_${index}`, output: [], status: "completed" },
      );
    }
    flushResponseState();
    const path = join(home, "responses-state.json");
    const beforeTouch = readFileSync(path, "utf-8");

    expandPreviousResponseInput({ previous_response_id: "resp_reload_lru_0", input: "touch" });
    flushResponseState();
    expect(readFileSync(path, "utf-8")).toBe(beforeTouch);

    rememberResponseState(
      { input: "persist touched order" },
      { id: "resp_reload_lru_1000", output: [], status: "completed" },
    );
    flushResponseState();
    const persisted = JSON.parse(readFileSync(path, "utf-8")) as { states: [string, unknown][] };
    expect(persisted.states.slice(-2).map(([id]) => id)).toEqual([
      "resp_reload_lru_0",
      "resp_reload_lru_1000",
    ]);

    clearResponseStateMemoryForTests();
    rememberResponseState(
      { input: "post-reload entry" },
      { id: "resp_reload_lru_1001", output: [], status: "completed" },
    );

    const protectedRead = expandPreviousResponseInput({
      previous_response_id: "resp_reload_lru_0",
      input: "still present after reload",
    }) as { input: Array<{ content?: string }> };
    expect(protectedRead.input[0]?.content).toBe("input-0");
    const evictedRead = { previous_response_id: "resp_reload_lru_2", input: "evicted after reload" };
    expect(expandPreviousResponseInput(evictedRead)).toEqual(evictedRead);
  });

  test("stale snapshot entries are pruned on load", () => {
    const first = buildResponseJSON([
      { type: "text_delta", text: "old" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "old turn" }, first);
    flushResponseState();
    clearResponseStateMemoryForTests();

    // Rewrite the snapshot with an expired createdAt (2h ago > 1h TTL).
    const path = join(home, "responses-state.json");
    const snapshot = JSON.parse(readFileSync(path, "utf-8")) as {
      states: [string, { createdAt: number }][];
    };
    for (const [, state] of snapshot.states) state.createdAt = Date.now() - 2 * 60 * 60 * 1_000;
    writeFileSync(path, JSON.stringify(snapshot));

    const second = {
      model: "gpt-5.5",
      previous_response_id: first.id,
      input: "next",
    };
    expect(expandPreviousResponseInput(second)).toEqual(second);
  });

  test("corrupt snapshot file is ignored", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "responses-state.json"), "{not json!!");

    const second = {
      model: "gpt-5.5",
      previous_response_id: "resp_nope",
      input: "next",
    };
    expect(expandPreviousResponseInput(second)).toEqual(second);

    // Store still functions after the failed load.
    const first = buildResponseJSON([
      { type: "text_delta", text: "fresh" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "hi" }, first);
    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: first.id,
      input: "next",
    }) as { input: unknown[] };
    expect(expanded.input).toHaveLength(3);
  });

  test("keeps accumulated response state within its byte budget across 120 turns", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = String(16 * 1024);
    clearResponseStateMemoryForTests();
    let history: unknown[] = [];
    let latest: ReturnType<typeof buildResponseJSON> | undefined;

    for (let turn = 0; turn < 120; turn += 1) {
      latest = buildResponseJSON([
        { type: "text_delta", text: `answer-${turn}-${"x".repeat(180)}` },
        { type: "done" },
      ], "gpt-5.5");
      const input = [...history, { role: "user", content: `turn-${turn}-${"u".repeat(180)}` }];
      rememberResponseState({ model: "gpt-5.5", input }, latest);
      history = [...input, ...(latest.output as unknown[])];

      const stats = responseStateStatsForTests();
      expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    }

    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: latest!.id,
      input: "newest continuation",
    }) as { input: unknown[] };
    expect(expanded.input.at(-1)).toEqual({ role: "user", content: "newest continuation" });
    expect(expanded.input.length).toBeGreaterThan(1);
    expect(expanded.input.length).toBeLessThan(history.length);
  });

  test("bounds an individually oversized entry while retaining newest continuation metadata", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = "512";
    clearResponseStateMemoryForTests();
    const response = buildResponseJSON([
      { type: "text_delta", text: "z".repeat(64 * 1024) },
      { type: "done" },
    ], "cursor/auto");

    rememberResponseState({ model: "cursor/auto", input: "latest" }, response, "cursor_oversized");

    const stats = responseStateStatsForTests();
    expect(stats).toEqual(expect.objectContaining({ entries: 1, maxBytes: 512 }));
    expect(stats.bytes).toBeLessThanOrEqual(512);
    expect(previousResponseConversationId(response.id as string)).toBe("cursor_oversized");
    const expanded = expandPreviousResponseInput({
      model: "cursor/auto",
      previous_response_id: response.id,
      input: "continue",
    }) as { input: unknown[] };
    expect(expanded.input.at(-1)).toEqual({ role: "user", content: "continue" });
  });

  test("trims a tool call and its output together instead of retaining a dangling output", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = "650";
    clearResponseStateMemoryForTests();
    const callId = "call_trimmed_pair";
    rememberResponseState({
      model: "gpt-5.5",
      input: [
        { role: "user", content: "old context ".repeat(200) },
        {
          type: "function_call",
          call_id: callId,
          name: "lookup",
          arguments: JSON.stringify({ schema: "c".repeat(300) }),
        },
        { type: "function_call_output", call_id: callId, output: "r".repeat(200) },
        { role: "user", content: "latest safe boundary" },
      ],
    }, { id: "resp_tool_trim", output: [], status: "completed" });

    const expanded = expandPreviousResponseInput({
      model: "gpt-5.5",
      previous_response_id: "resp_tool_trim",
      input: "continue",
    }) as { input: Array<Record<string, unknown>> };
    const retainedCalls = new Set<string>();
    for (const item of expanded.input) {
      if (item.type === "function_call" && typeof item.call_id === "string") retainedCalls.add(item.call_id);
      if (item.type === "function_call_output") {
        expect(retainedCalls.has(item.call_id as string)).toBe(true);
      }
    }
    expect(expanded.input.some(item => item.type === "function_call_output")).toBe(false);
    expect(expanded.input.some(item => item.content === "latest safe boundary")).toBe(true);
    expect(responseStateStatsForTests().bytes).toBeLessThanOrEqual(650);
  });

  test("falls back to previous_response_id when an oversized pending call cannot be retained", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = "300";
    clearResponseStateMemoryForTests();
    rememberResponseState({ model: "gpt-5.5", input: "run it" }, {
      id: "resp_pending_trim",
      status: "completed",
      output: [{
        type: "function_call",
        call_id: "call_too_large",
        name: "large_tool",
        arguments: JSON.stringify({ value: "x".repeat(2_000) }),
      }],
    });
    const next = {
      model: "gpt-5.5",
      previous_response_id: "resp_pending_trim",
      input: [{ type: "function_call_output", call_id: "call_too_large", output: "done" }],
    };

    expect(expandPreviousResponseInput(next)).toEqual(next);
    expect(responseStateStatsForTests().bytes).toBeLessThanOrEqual(300);
  });

  test("caps snapshot state while admitting the newest history first", () => {
    process.env["OPENCODEX_RESPONSE_STATE_MAX_BYTES"] = "900";
    const path = join(home, "responses-state.json");
    const createdAt = Date.now();
    writeFileSync(path, JSON.stringify({
      version: 1,
      states: [
        ["resp_old", { createdAt, items: [{ role: "user", content: "o".repeat(600) }] }],
        ["resp_new", { createdAt: createdAt + 1, items: [{ role: "user", content: "n".repeat(600) }] }],
      ],
    }));
    clearResponseStateMemoryForTests();

    const stats = responseStateStatsForTests();
    expect(stats.bytes).toBeLessThanOrEqual(900);
    const newest = expandPreviousResponseInput({ previous_response_id: "resp_new", input: "next" }) as {
      input: Array<{ content?: string }>;
    };
    expect(newest.input[0]?.content).toBe("n".repeat(600));
  });

  test("oversized entries stay in memory but are skipped on disk", () => {
    const big = "x".repeat(3 * 1024 * 1024); // > 2MiB per-entry cap
    const first = buildResponseJSON([
      { type: "text_delta", text: big },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "big turn" }, first);

    const small = buildResponseJSON([
      { type: "text_delta", text: "small" },
      { type: "done" },
    ], "gpt-5.5");
    rememberResponseState({ model: "gpt-5.5", input: "small turn" }, small);
    flushResponseState();

    // In-memory: both expand.
    expect((expandPreviousResponseInput({
      model: "gpt-5.5", previous_response_id: first.id, input: "n",
    }) as { input: unknown[] }).input).toHaveLength(3);

    // After restart: only the small entry survived on disk.
    clearResponseStateMemoryForTests();
    const bigMiss = { model: "gpt-5.5", previous_response_id: first.id, input: "n" };
    expect(expandPreviousResponseInput(bigMiss)).toEqual(bigMiss);
    expect((expandPreviousResponseInput({
      model: "gpt-5.5", previous_response_id: small.id, input: "n",
    }) as { input: unknown[] }).input).toHaveLength(3);
  });

  test("stores provider conversation id alongside Responses output state", () => {
    const firstBody = { model: "cursor/auto", input: "use ping" };
    const first = buildResponseJSON([
      { type: "text_delta", text: "hello" },
      { type: "done" },
    ], "cursor/auto");

    rememberResponseState(firstBody, first, "cursor_conversation_1");

    expect(previousResponseConversationId(first.id as string)).toBe("cursor_conversation_1");
  });

  test("preserves provider conversation id after a client tool-call response (multi-turn continuation)", () => {
    const firstBody = { model: "cursor/auto", input: "use ping" };
    const first = buildResponseJSON([
      { type: "tool_call_start", id: "call_1", name: "ping" },
      { type: "tool_call_end", id: "call_1" },
      { type: "done" },
    ], "cursor/auto");

    rememberResponseState(firstBody, first, "cursor_conversation_1");

    // The conversation id MUST survive a tool-call response so the following tool-result turn
    // continues the SAME Cursor conversation. The Cursor checkpoint is not reusable (the agent turn
    // was suspended without a real mcpResult), but the conversation id string itself is preserved.
    expect(previousResponseConversationId(first.id as string)).toBe("cursor_conversation_1");
  });
});
