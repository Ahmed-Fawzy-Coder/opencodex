import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextResultStore } from "../src/context-results";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(repoRoot, "src", "cli", "index.ts");
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-context-cli-"));
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  root = "";
});

function run(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: root },
    encoding: "utf-8",
  });
}

test("ocx context get retrieves bounded chunks and supports conditional ETags", () => {
  const store = new ContextResultStore({ rootDir: join(root, "context-results"), retrievalMaxBytes: 8 });
  const saved = store.put("0123456789abcdef")!;

  const first = run(["context", "get", saved.handle, "--offset", "2", "--max-bytes", "8"]);
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  const payload = JSON.parse(first.stdout);
  expect(payload).toMatchObject({ ok: true, handle: saved.handle, offset: 2, nextOffset: 10, hasMore: true });
  expect(payload.content).toBe("23456789");
  expect(payload.sha256).toBe(saved.sha256);

  const cached = run(["context", "get", saved.handle, "--if-none-match", saved.etag]);
  expect(cached.status).toBe(0);
  expect(JSON.parse(cached.stdout)).toMatchObject({ ok: true, notModified: true, etag: saved.etag });
});

test("ocx context get rejects paths, malformed bounds, and unknown options as compact JSON", () => {
  for (const args of [
    ["context", "get", "../../config.json"],
    ["context", "get", "ctx_short", "--offset", "-1"],
    ["context", "get", "ctx_short", "--max-bytes", "0"],
    ["context", "get", "ctx_short", "--path", "/tmp/secret"],
  ]) {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload)).not.toContain(root);
  }
});
