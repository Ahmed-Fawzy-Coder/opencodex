import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, readConfigDiagnostics } from "../src/config";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-context-config-"));
  process.env.OPENCODEX_HOME = root;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  root = "";
});

function baseConfig(ultimateContext: unknown) {
  return {
    port: 10100,
    providers: { custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
    defaultProvider: "custom",
    ultimateContext,
  };
}

test("Ultimate Context is disabled by default and valid bounded controls load", () => {
  expect(getDefaultConfig().ultimateContext).toBeUndefined();
  writeFileSync(getConfigPath(), JSON.stringify(baseConfig({
    enabled: true,
    mode: "auto",
    thresholdBytes: 4096,
    previewBytes: 512,
    ttlMs: 60_000,
    maxEntries: 12,
    maxBytes: 1_000_000,
    retrievalMaxBytes: 8_192,
  })));

  expect(loadConfig().ultimateContext).toEqual({
    enabled: true,
    mode: "auto",
    thresholdBytes: 4096,
    previewBytes: 512,
    ttlMs: 60_000,
    maxEntries: 12,
    maxBytes: 1_000_000,
    retrievalMaxBytes: 8_192,
  });
});

test("invalid or unknown Ultimate Context controls fail closed to fallback config", () => {
  for (const invalid of [
    { enabled: true, mode: "aggressive" },
    { enabled: true, maxBytes: -1 },
    { enabled: true, storePath: "/tmp/attacker-controlled" },
  ]) {
    writeFileSync(getConfigPath(), JSON.stringify(baseConfig(invalid)));
    const diagnostics = readConfigDiagnostics();
    expect(diagnostics.source).toBe("fallback");
    expect(diagnostics.config.ultimateContext).toBeUndefined();
  }
});
