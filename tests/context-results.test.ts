import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUltimateContextInPlace,
  ContextResultStore,
  readUltimateContextMetrics,
  resetUltimateContextMetrics,
} from "../src/context-results";
import { parseRequest } from "../src/responses/parser";
import { sanitizeEncryptedContentInPlace } from "../src/server/responses";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-context-results-"));
  process.env.OPENCODEX_HOME = root;
  resetUltimateContextMetrics();
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  root = "";
});

function store(overrides: Partial<ConstructorParameters<typeof ContextResultStore>[0]> = {}) {
  return new ContextResultStore({
    rootDir: join(root, "store"),
    secret: Buffer.alloc(32, 7),
    ...overrides,
  });
}

function body(output: string, context?: Record<string, unknown>) {
  return {
    model: "test/model",
    input: [
      {
        type: "function_call",
        call_id: "call-1",
        name: "mcp__linux_mcp__workspace",
        arguments: JSON.stringify({ action: "read_file", path: "/tmp/example" }),
      },
      { type: "function_call_output", call_id: "call-1", output, ...(context ? { _context: context } : {}) },
    ],
  };
}

function outputItem(value: ReturnType<typeof body>) {
  return value.input[1] as { output: string; _context?: unknown };
}

describe("Ultimate Context transformer", () => {
  test("is a byte-for-byte no-op while disabled", () => {
    const value = body(JSON.stringify({ content: "x".repeat(20_000), _telemetry: { secret: "no" } }));
    const before = JSON.stringify(value);

    const result = applyUltimateContextInPlace(value, { enabled: false }, store());

    expect(JSON.stringify(value)).toBe(before);
    expect(result.transformedResults).toBe(0);
    expect(readUltimateContextMetrics().transforms).toBe(0);
  });

  test("is deterministic and idempotent, strips telemetry, and reports conservative completeness", () => {
    const snapshot = JSON.stringify({
      ok: true,
      content: "line\n".repeat(5_000),
      has_more: true,
      truncated: false,
      _telemetry: { source_chars: 99_999 },
    });
    const first = body(snapshot);
    const second = body(snapshot);
    const contextStore = store();
    const config = { enabled: true, mode: "auto" as const, thresholdBytes: 100, previewBytes: 512 };

    const firstResult = applyUltimateContextInPlace(first, config, contextStore);
    const stable = outputItem(first).output;
    applyUltimateContextInPlace(first, config, contextStore);
    applyUltimateContextInPlace(second, config, contextStore);

    expect(outputItem(first).output).toBe(stable);
    expect(outputItem(second).output).toBe(stable);
    expect(stable).not.toContain("_telemetry");
    const compacted = JSON.parse(stable);
    expect(compacted.action).toBe("mcp__linux_mcp__workspace:read_file");
    expect(compacted._context_result.snapshot_complete).toBe(true);
    expect(compacted._context_result.source_complete).toBe(false);
    expect(compacted.summary.content).toContain("_context_result.retrieval");
    expect(compacted._context_result.retrieval).toContain("ocx context get");
    expect(firstResult.savedBytes).toBeGreaterThan(0);
  });

  test("honors per-result mode, intent, and if_none_match without leaking controls", () => {
    const contextStore = store();
    const raw = JSON.stringify({ ok: true, content: `old\n${"middle\n".repeat(1_000)}latest`, has_more: false, truncated: false });
    const first = body(raw, { mode: "compact", intent: "latest" });
    applyUltimateContextInPlace(first, { enabled: true, mode: "auto", thresholdBytes: 1_000_000, previewBytes: 256 }, contextStore);
    const initial = JSON.parse(outputItem(first).output);
    expect(initial.summary.content).toContain("latest");
    expect(outputItem(first)._context).toBeUndefined();

    const cached = body(raw, { mode: "compact", if_none_match: initial._context_result.etag });
    applyUltimateContextInPlace(cached, { enabled: true, previewBytes: 256 }, contextStore);
    const cacheResult = JSON.parse(outputItem(cached).output);
    expect(cacheResult._context_result.not_modified).toBe(true);
    expect(cacheResult.summary).toBeUndefined();

    const off = body(raw, { mode: "off" });
    applyUltimateContextInPlace(off, { enabled: true, mode: "compact" }, contextStore);
    expect(outputItem(off).output).toBe(raw);
    expect(outputItem(off)._context).toBeUndefined();
  });

  test("keeps tiny Unicode previews byte bounded without leaking the source", () => {
    const value = body(JSON.stringify({
      content: "😀private-source".repeat(100),
      has_more: false,
      truncated: false,
    }));

    applyUltimateContextInPlace(value, { enabled: true, mode: "compact", previewBytes: 1 }, store());

    const compacted = JSON.parse(outputItem(value).output);
    expect(Buffer.byteLength(compacted.summary.content, "utf-8")).toBeLessThanOrEqual(1);
    expect(compacted.summary.content).not.toContain("private-source");
  });

  test("fits the sanitize-then-transform-then-parse universal request pipeline", () => {
    const value = body(JSON.stringify({ ok: true, content: "result\n".repeat(2_000), has_more: false, truncated: false }));
    expect(sanitizeEncryptedContentInPlace(value.input)).toBe(0);
    applyUltimateContextInPlace(value, { enabled: true, mode: "compact", previewBytes: 256 }, store());

    const parsed = parseRequest(value);
    const toolResult = parsed.context.messages.find(message => message.role === "toolResult");
    expect(toolResult?.content).toContain("_context_result");
    expect(toolResult?.content).toContain("snapshot_complete");
  });

  test("skips Linux MCP context envelopes so combined metrics never double count savings", () => {
    const linuxEnvelope = JSON.stringify({
      ok: true,
      content: "already compact",
      _context_result: {
        id: "cr_opaque-linux-id",
        sha256: "a".repeat(64),
        snapshot_complete: true,
        source_complete: false,
        reduced: true,
      },
    });
    const value = body(linuxEnvelope, { mode: "compact" });

    const result = applyUltimateContextInPlace(value, { enabled: true, mode: "compact" }, store());

    expect(outputItem(value).output).toBe(linuxEnvelope);
    expect(result.transformedResults).toBe(0);
    expect(result.inputBytes).toBe(0);
    expect(result.savedBytes).toBe(0);
    expect(readUltimateContextMetrics().storeWrites).toBe(0);
  });
});

describe("ContextResultStore", () => {
  test("uses opaque handles, atomic private files, bounded retrieval, SHA-256, and ETags", () => {
    const contextStore = store({ retrievalMaxBytes: 16 });
    const content = "0123456789abcdefghijklmnopqrstuvwxyz";
    const saved = contextStore.put(content)!;

    expect(saved.handle).toMatch(/^ctx_[A-Za-z0-9_-]{43}$/);
    expect(saved.handle).not.toContain(content.slice(0, 8));
    expect(statSync(contextStore.rootDir).mode & 0o777).toBe(0o700);
    const entry = join(contextStore.rootDir, `${saved.handle}.json`);
    expect(statSync(entry).mode & 0o777).toBe(0o600);

    const first = contextStore.get(saved.handle, { offset: 0, maxBytes: 10 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("retrieval failed");
    expect(first.content).toBe("0123456789");
    expect(first.nextOffset).toBe(10);
    expect(first.hasMore).toBe(true);
    expect(first.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(Buffer.from(first.contentBase64!, "base64").toString("utf-8")).toBe(first.content);

    const second = contextStore.get(saved.handle, { offset: first.nextOffset, maxBytes: 999 });
    expect(second.ok && Buffer.byteLength(second.content ?? "")).toBeLessThanOrEqual(16);
    const cached = contextStore.get(saved.handle, { ifNoneMatch: saved.etag });
    expect(cached.ok && cached.notModified).toBe(true);
    expect(cached.ok && cached.content).toBeUndefined();
  });

  test("makes byte-bounded progress across split UTF-8 code points", () => {
    const contextStore = store({ retrievalMaxBytes: 1 });
    const content = "😀é";
    const saved = contextStore.put(content)!;
    const chunks: Buffer[] = [];
    let offset = 0;

    while (offset < saved.bytes) {
      const result = contextStore.get(saved.handle, { offset, maxBytes: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("retrieval failed");
      const chunk = Buffer.from(result.contentBase64!, "base64");
      expect(chunk.byteLength).toBe(1);
      expect(result.nextOffset).toBeGreaterThan(offset);
      chunks.push(chunk);
      offset = result.nextOffset;
    }

    expect(Buffer.concat(chunks).toString("utf-8")).toBe(content);
  });

  test("creates and hardens the persistent handle key when no test secret is injected", () => {
    const contextStore = new ContextResultStore({ rootDir: join(root, "persistent") });
    const first = contextStore.put("secret-backed handle")!;
    const reopened = new ContextResultStore({ rootDir: contextStore.rootDir });
    const second = reopened.put("secret-backed handle")!;

    expect(second.handle).toBe(first.handle);
    expect(statSync(join(contextStore.rootDir, ".handle-key")).mode & 0o777).toBe(0o600);
  });

  test("rejects a symlinked handle key instead of reading outside the private store", () => {
    if (process.platform === "win32") return;
    const persistent = join(root, "persistent-symlink");
    const outside = join(root, "outside-key");
    mkdirSync(persistent, { mode: 0o700 });
    writeFileSync(outside, Buffer.alloc(32, 3).toString("base64url"), { mode: 0o600 });
    symlinkSync(outside, join(persistent, ".handle-key"));

    expect(() => new ContextResultStore({ rootDir: persistent })).toThrow("private regular file");
  });

  test("rejects invalid handles and offsets without path traversal", () => {
    const contextStore = store();
    const saved = contextStore.put("content")!;
    expect(contextStore.get("../../config.json")).toEqual({ ok: false, error: "invalid_handle" });
    expect(contextStore.get("ctx_short")).toEqual({ ok: false, error: "invalid_handle" });
    expect(contextStore.get(saved.handle, { offset: -1 })).toEqual({ ok: false, error: "invalid_offset" });
    expect(readUltimateContextMetrics().invalidHandles).toBe(2);
  });

  test("unique writes enforce TTL, entry, and byte caps", () => {
    let now = 1_000;
    const ttlStore = store({ ttlMs: 50, now: () => now });
    const expired = ttlStore.put("expires")!;
    now = 1_051;
    ttlStore.put("fresh");
    expect(ttlStore.get(expired.handle)).toEqual({ ok: false, error: "not_found" });

    const cappedRoot = join(root, "capped");
    const capped = new ContextResultStore({
      rootDir: cappedRoot,
      secret: Buffer.alloc(32, 8),
      maxEntries: 2,
      maxBytes: 100,
      now: () => now,
    });
    const first = capped.put("aaaa")!;
    now += 1;
    const second = capped.put("bbbb")!;
    now += 1;
    const third = capped.put("cccc")!;
    expect(capped.get(first.handle)).toEqual({ ok: false, error: "not_found" });
    expect(capped.get(second.handle).ok).toBe(true);
    expect(capped.get(third.handle).ok).toBe(true);
    expect(readdirSync(cappedRoot).filter(name => name.endsWith(".json"))).toHaveLength(2);

    const byteCapped = new ContextResultStore({
      rootDir: join(root, "byte-capped"),
      secret: Buffer.alloc(32, 9),
      maxEntries: 10,
      maxBytes: 7,
      now: () => now,
    });
    const bytesFirst = byteCapped.put("1111")!;
    now += 1;
    const bytesSecond = byteCapped.put("2222")!;
    expect(byteCapped.get(bytesFirst.handle)).toEqual({ ok: false, error: "not_found" });
    expect(byteCapped.get(bytesSecond.handle).ok).toBe(true);
    expect(readUltimateContextMetrics().evictedEntries).toBeGreaterThanOrEqual(1);
  });

  test("repeated identical puts bypass sweep and do not rewrite the stored envelope", () => {
    const contextStore = store();
    const first = contextStore.put("same immutable snapshot")!;
    const path = join(contextStore.rootDir, `${first.handle}.json`);
    const before = readFileSync(path, "utf-8");
    const beforeStat = statSync(path);
    let sweepCalls = 0;
    contextStore.sweep = () => { sweepCalls += 1; };

    for (let count = 0; count < 100; count += 1) {
      expect(contextStore.put("same immutable snapshot")).toEqual(first);
    }

    expect(sweepCalls).toBe(0);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(statSync(path).ino).toBe(beforeStat.ino);
  });

  test("an identical put after TTL replaces the expired envelope and records its expiration", () => {
    let now = 1_000;
    const contextStore = store({ ttlMs: 50, now: () => now });
    const first = contextStore.put("same content after expiry")!;

    now = 1_051;
    const second = contextStore.put("same content after expiry")!;
    const retrieval = contextStore.get(second.handle);

    expect(second.handle).toBe(first.handle);
    expect(second.expiresAt).toBe(1_101);
    expect(retrieval).toEqual(expect.objectContaining({
      ok: true,
      content: "same content after expiry",
    }));
    expect(readUltimateContextMetrics()).toEqual(expect.objectContaining({
      storeWrites: 2,
      expiredEntries: 1,
    }));
    expect(readdirSync(contextStore.rootDir).filter(name => name.endsWith(".json"))).toHaveLength(1);
  });

  test("deduplicates snapshots and exposes numeric-only aggregate metrics", () => {
    const contextStore = store();
    const first = contextStore.put("same")!;
    const second = contextStore.put("same")!;
    contextStore.get(first.handle, { maxBytes: 2 });
    const values = readUltimateContextMetrics();

    expect(second).toEqual(first);
    expect(values.storeWrites).toBe(1);
    expect(values.storeHits).toBe(1);
    expect(values.retrievals).toBe(1);
    expect(Object.values(values).every(value => typeof value === "number" && Number.isFinite(value))).toBe(true);
  });

  test("persists private aggregate metrics across restart and fails closed on malformed state", () => {
    const contextStore = store();
    const value = body(JSON.stringify({ content: "persist\n".repeat(2_000), has_more: false, truncated: false }));
    applyUltimateContextInPlace(value, { enabled: true, mode: "compact", previewBytes: 256 }, contextStore);
    const beforeRestart = readUltimateContextMetrics();
    const statePath = join(root, "ultimate-context-metrics.json");
    expect(beforeRestart.transformedResults).toBe(1);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);

    const other = mkdtempSync(join(tmpdir(), "ocx-context-other-"));
    process.env.OPENCODEX_HOME = other;
    expect(readUltimateContextMetrics().transformedResults).toBe(0);
    process.env.OPENCODEX_HOME = root;
    expect(readUltimateContextMetrics()).toEqual(beforeRestart);

    writeFileSync(statePath, "{malformed", { mode: 0o600 });
    process.env.OPENCODEX_HOME = other;
    readUltimateContextMetrics();
    process.env.OPENCODEX_HOME = root;
    expect(readUltimateContextMetrics()).toEqual(expect.objectContaining({
      transforms: 0,
      transformedResults: 0,
      savedBytes: 0,
    }));
    rmSync(other, { recursive: true, force: true });
  });
});
