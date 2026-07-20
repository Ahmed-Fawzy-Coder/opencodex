import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUltimateContextInPlace,
  ContextResultStore,
  readUltimateContextMetrics,
  resetUltimateContextMetrics,
} from "../src/context-results";

const root = mkdtempSync(join(tmpdir(), "ocx-context-benchmark-"));
const rounds: Array<Record<string, number | boolean>> = [];
const previousHome = process.env.OPENCODEX_HOME;

try {
  process.env.OPENCODEX_HOME = root;
  resetUltimateContextMetrics();
  const store = new ContextResultStore({
    rootDir: join(root, "store"),
    secret: Buffer.alloc(32, 9),
    maxBytes: 128 * 1024 * 1024,
  });
  for (let round = 1; round <= 10; round += 1) {
    const raw = JSON.stringify({
      ok: true,
      content: Array.from({ length: 4_000 }, (_, index) => `round=${round} line=${index} value=${"x".repeat(32)}`).join("\n"),
      has_more: false,
      truncated: false,
      _telemetry: { source_chars: 999_999 },
    });
    const makeBody = (ifNoneMatch?: string) => ({
      model: "benchmark/model",
      input: [
        { type: "function_call", call_id: `call-${round}`, name: "workspace", arguments: JSON.stringify({ action: "read_file" }) },
        {
          type: "function_call_output",
          call_id: `call-${round}`,
          output: raw,
          _context: { mode: "compact", intent: "latest", ...(ifNoneMatch ? { if_none_match: ifNoneMatch } : {}) },
        },
      ],
    });
    const first = makeBody();
    const measured = applyUltimateContextInPlace(first, { enabled: true, previewBytes: 1_024 }, store);
    const returned = (first.input[1] as { output: string }).output;
    const parsed = JSON.parse(returned);
    const handle = parsed._context_result.handle as string;
    const etag = parsed._context_result.etag as string;
    const retrieval = store.get(handle, { offset: 0, maxBytes: 2_048 });
    const retry = makeBody();
    applyUltimateContextInPlace(retry, { enabled: true, previewBytes: 1_024 }, store);
    const cache = makeBody(etag);
    applyUltimateContextInPlace(cache, { enabled: true, previewBytes: 1_024 }, store);
    const cachePayload = JSON.parse((cache.input[1] as { output: string }).output);
    const row = {
      round,
      beforeBytes: measured.inputBytes,
      returnedBytes: measured.returnedBytes,
      savedBytes: measured.savedBytes,
      latencyMs: Number(measured.latencyMs.toFixed(3)),
      retrievalOk: retrieval.ok,
      retryDeterministic: (retry.input[1] as { output: string }).output === returned,
      cacheNotModified: cachePayload._context_result.not_modified === true,
    };
    rounds.push(row);
    console.log(JSON.stringify({ type: "round", ...row }));
  }
  const latencies = rounds.map(round => Number(round.latencyMs)).sort((a, b) => a - b);
  const aggregate = {
    rounds: rounds.length,
    beforeBytes: rounds.reduce((sum, round) => sum + Number(round.beforeBytes), 0),
    returnedBytes: rounds.reduce((sum, round) => sum + Number(round.returnedBytes), 0),
    savedBytes: rounds.reduce((sum, round) => sum + Number(round.savedBytes), 0),
    medianLatencyMs: Number(((latencies[4] + latencies[5]) / 2).toFixed(3)),
    worstLatencyMs: Math.max(...latencies),
    retrievalSuccesses: rounds.filter(round => round.retrievalOk).length,
    deterministicRetries: rounds.filter(round => round.retryDeterministic).length,
    cacheNotModified: rounds.filter(round => round.cacheNotModified).length,
    metrics: readUltimateContextMetrics(),
  };
  console.log(JSON.stringify({ type: "aggregate", ...aggregate }));
} finally {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}
