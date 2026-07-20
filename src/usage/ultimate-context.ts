export interface ContextSavingsLayer {
  active: boolean;
  processedCalls: number;
  reducedCalls: number;
  estimatedBeforeTokens: number;
  estimatedReturnedTokens: number;
  estimatedSavedTokens: number;
  estimatedSavingsRatio: number;
  retrievalCalls: number;
  cacheHits: number;
  sourceIncompleteCalls: number;
  errors: number;
  addedLatencyMs: number;
}

export interface UltimateContextSummary extends ContextSavingsLayer {
  layers: {
    linuxMcp: ContextSavingsLayer;
    allTools: ContextSavingsLayer;
  };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function field(source: Record<string, unknown> | null, name: string): number {
  return source ? finiteNonNegative(source[name]) : 0;
}

function estimatedTokens(charsOrBytes: number): number {
  return Math.ceil(charsOrBytes / 4);
}

function layer(values: Omit<ContextSavingsLayer, "estimatedSavingsRatio">): ContextSavingsLayer {
  return {
    ...values,
    estimatedSavingsRatio: values.estimatedBeforeTokens > 0
      ? Math.min(1, values.estimatedSavedTokens / values.estimatedBeforeTokens)
      : 0,
  };
}

/**
 * Combine two disjoint context boundaries without changing provider usage accounting.
 * Linux MCP owns its compact gateway results; the OpenCodex layer must skip those
 * already-reduced envelopes so the same saved bytes are never counted twice.
 */
export function summarizeUltimateContext(
  linuxTelemetry: Record<string, unknown> | null,
  universalMetrics: Record<string, unknown> | null,
  universalActive: boolean,
): UltimateContextSummary {
  const linuxReturnedChars = field(linuxTelemetry, "returnedChars");
  const linuxBeforeChars = Math.max(field(linuxTelemetry, "estimatedBaselineChars"), linuxReturnedChars);
  const linuxSavedChars = Math.max(0, linuxBeforeChars - linuxReturnedChars);
  const linuxBeforeTokens = estimatedTokens(linuxBeforeChars);
  const linuxReturnedTokens = estimatedTokens(linuxReturnedChars);
  const linuxSavedTokens = Math.max(0, linuxBeforeTokens - linuxReturnedTokens);
  const linuxMcp = layer({
    active: linuxTelemetry !== null,
    processedCalls: field(linuxTelemetry, "measuredCalls"),
    reducedCalls: field(linuxTelemetry, "boundedCalls"),
    estimatedBeforeTokens: linuxBeforeTokens,
    estimatedReturnedTokens: linuxReturnedTokens,
    estimatedSavedTokens: linuxBeforeChars > 0 ? linuxSavedTokens : estimatedTokens(linuxSavedChars),
    retrievalCalls: field(linuxTelemetry, "contextRetrievals"),
    cacheHits: field(linuxTelemetry, "contextNotModified"),
    sourceIncompleteCalls: field(linuxTelemetry, "contextSourceIncomplete"),
    errors: 0,
    addedLatencyMs: 0,
  });

  const toolReturnedBytes = field(universalMetrics, "returnedBytes");
  const toolBeforeBytes = Math.max(field(universalMetrics, "inputBytes"), toolReturnedBytes);
  const toolBeforeTokens = estimatedTokens(toolBeforeBytes);
  const toolReturnedTokens = estimatedTokens(toolReturnedBytes);
  const allTools = layer({
    active: universalActive,
    processedCalls: field(universalMetrics, "transformedResults") + field(universalMetrics, "bypassedResults"),
    reducedCalls: field(universalMetrics, "transformedResults"),
    estimatedBeforeTokens: toolBeforeTokens,
    estimatedReturnedTokens: toolReturnedTokens,
    estimatedSavedTokens: Math.max(0, toolBeforeTokens - toolReturnedTokens),
    retrievalCalls: field(universalMetrics, "retrievals"),
    cacheHits: field(universalMetrics, "storeHits") + field(universalMetrics, "notModified"),
    sourceIncompleteCalls: 0,
    errors: field(universalMetrics, "errors"),
    addedLatencyMs: field(universalMetrics, "latencyMsTotal"),
  });

  const before = linuxMcp.estimatedBeforeTokens + allTools.estimatedBeforeTokens;
  const returned = linuxMcp.estimatedReturnedTokens + allTools.estimatedReturnedTokens;
  const saved = Math.max(0, before - returned);
  return {
    ...layer({
      active: linuxMcp.active || allTools.active,
      processedCalls: linuxMcp.processedCalls + allTools.processedCalls,
      reducedCalls: linuxMcp.reducedCalls + allTools.reducedCalls,
      estimatedBeforeTokens: before,
      estimatedReturnedTokens: returned,
      estimatedSavedTokens: saved,
      retrievalCalls: linuxMcp.retrievalCalls + allTools.retrievalCalls,
      cacheHits: linuxMcp.cacheHits + allTools.cacheHits,
      sourceIncompleteCalls: linuxMcp.sourceIncompleteCalls,
      errors: linuxMcp.errors + allTools.errors,
      addedLatencyMs: linuxMcp.addedLatencyMs + allTools.addedLatencyMs,
    }),
    layers: { linuxMcp, allTools },
  };
}
