import { describe, expect, test } from "bun:test";
import { summarizeUltimateContext } from "../src/usage/ultimate-context";

describe("summarizeUltimateContext", () => {
  test("combines disjoint Linux MCP and other-tool savings without double counting", () => {
    const summary = summarizeUltimateContext({
      measuredCalls: 8,
      boundedCalls: 3,
      estimatedBaselineChars: 400,
      returnedChars: 100,
      contextRetrievals: 2,
      contextNotModified: 1,
      contextSourceIncomplete: 1,
    }, {
      transformedResults: 4,
      bypassedResults: 6,
      inputBytes: 800,
      returnedBytes: 200,
      savedBytes: 600,
      retrievals: 1,
      storeHits: 2,
      notModified: 1,
      errors: 0,
      latencyMsTotal: 20,
    }, true);

    expect(summary).toMatchObject({
      active: true,
      processedCalls: 18,
      reducedCalls: 7,
      estimatedBeforeTokens: 300,
      estimatedReturnedTokens: 75,
      estimatedSavedTokens: 225,
      estimatedSavingsRatio: 0.75,
      retrievalCalls: 3,
      cacheHits: 4,
      sourceIncompleteCalls: 1,
      errors: 0,
      addedLatencyMs: 20,
    });
    expect(summary.layers.linuxMcp.estimatedSavedTokens).toBe(75);
    expect(summary.layers.allTools.estimatedSavedTokens).toBe(150);
  });

  test("returns a stable inactive zero shape when both telemetry sources are absent", () => {
    expect(summarizeUltimateContext(null, null, false)).toEqual({
      active: false,
      processedCalls: 0,
      reducedCalls: 0,
      estimatedBeforeTokens: 0,
      estimatedReturnedTokens: 0,
      estimatedSavedTokens: 0,
      estimatedSavingsRatio: 0,
      retrievalCalls: 0,
      cacheHits: 0,
      sourceIncompleteCalls: 0,
      errors: 0,
      addedLatencyMs: 0,
      layers: {
        linuxMcp: expect.objectContaining({ active: false, estimatedBeforeTokens: 0 }),
        allTools: expect.objectContaining({ active: false, estimatedBeforeTokens: 0 }),
      },
    });
  });

  test("rejects malformed and negative counters and never reports negative savings", () => {
    const summary = summarizeUltimateContext({
      measuredCalls: -1,
      boundedCalls: Number.NaN,
      estimatedBaselineChars: 20,
      returnedChars: 40,
    }, {
      transformedResults: "4",
      bypassedResults: -2,
      inputBytes: 10,
      returnedBytes: 20,
      savedBytes: 0,
      errors: Number.POSITIVE_INFINITY,
    }, true);

    expect(summary.estimatedBeforeTokens).toBe(15);
    expect(summary.estimatedReturnedTokens).toBe(15);
    expect(summary.estimatedSavedTokens).toBe(0);
    expect(summary.estimatedSavingsRatio).toBe(0);
    expect(summary.processedCalls).toBe(0);
    expect(summary.errors).toBe(0);
  });

  test("uses recorded savings instead of inferring them from legacy expanded results", () => {
    const summary = summarizeUltimateContext(null, {
      transformedResults: 2,
      bypassedResults: 1,
      inputBytes: 1_000,
      returnedBytes: 1_100,
      savedBytes: 200,
    }, true);

    expect(summary.layers.allTools.estimatedBeforeTokens).toBe(325);
    expect(summary.layers.allTools.estimatedReturnedTokens).toBe(275);
    expect(summary.layers.allTools.estimatedSavedTokens).toBe(50);
    expect(summary.layers.allTools.estimatedSavingsRatio).toBeCloseTo(50 / 325);
  });
});
