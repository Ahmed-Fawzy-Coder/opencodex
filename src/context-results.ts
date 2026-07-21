import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config";
import { hardenSecretDir, hardenSecretPath } from "./lib/windows-secret-acl";
import type { OcxUltimateContextConfig } from "./types";

const HANDLE_PATTERN = /^ctx_[A-Za-z0-9_-]{43}$/;
const ENTRY_VERSION = 1;
const DEFAULT_THRESHOLD_BYTES = 8_192;
const DEFAULT_PREVIEW_BYTES = 2_048;
const DEFAULT_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETRIEVAL_MAX_BYTES = 64 * 1024;

export interface UltimateContextMetrics {
  transforms: number;
  transformedResults: number;
  bypassedResults: number;
  inputBytes: number;
  returnedBytes: number;
  savedBytes: number;
  storeWrites: number;
  storeHits: number;
  storeRejected: number;
  retrievals: number;
  retrievalBytes: number;
  modelRequestedRetrievals: number;
  automaticRetrievals: number;
  retrievalNoProgress: number;
  answersWithIncompleteSource: number;
  notModified: number;
  invalidHandles: number;
  expiredEntries: number;
  evictedEntries: number;
  evictedBytes: number;
  errors: number;
  latencyMsTotal: number;
  latencyMsMax: number;
}

const metrics: UltimateContextMetrics = {
  transforms: 0,
  transformedResults: 0,
  bypassedResults: 0,
  inputBytes: 0,
  returnedBytes: 0,
  savedBytes: 0,
  storeWrites: 0,
  storeHits: 0,
  storeRejected: 0,
  retrievals: 0,
  retrievalBytes: 0,
  modelRequestedRetrievals: 0,
  automaticRetrievals: 0,
  retrievalNoProgress: 0,
  answersWithIncompleteSource: 0,
  notModified: 0,
  invalidHandles: 0,
  expiredEntries: 0,
  evictedEntries: 0,
  evictedBytes: 0,
  errors: 0,
  latencyMsTotal: 0,
  latencyMsMax: 0,
};

const METRIC_KEYS = Object.keys(metrics) as Array<keyof UltimateContextMetrics>;
let loadedMetricsPath: string | null = null;
let metricsBatchDepth = 0;
let metricsDirty = false;

function clearMetrics(): void {
  for (const key of METRIC_KEYS) metrics[key] = 0;
}

function metricsStatePath(): string {
  return join(getConfigDir(), "ultimate-context-metrics.json");
}

function validPersistedMetrics(value: unknown): value is UltimateContextMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return METRIC_KEYS.every(key => (
    typeof record[key] === "number"
    && Number.isFinite(record[key])
    && Number(record[key]) >= 0
  ));
}

function ensureMetricsLoaded(): void {
  const path = metricsStatePath();
  if (loadedMetricsPath === path) return;
  loadedMetricsPath = path;
  clearMetrics();
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return;
    const state = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; metrics?: unknown };
    if (state.version !== 1 || !validPersistedMetrics(state.metrics)) return;
    Object.assign(metrics, state.metrics);
    hardenFile(path);
  } catch {
    // Missing or malformed state fails closed to a fresh all-zero aggregate.
  }
}

function persistMetricsNow(): void {
  ensureMetricsLoaded();
  const path = metricsStatePath();
  const dir = getConfigDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    hardenDirectory(dir);
    const temp = join(dir, `.ultimate-context-metrics.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeExclusiveFile(temp, JSON.stringify({ version: 1, metrics }));
      renameSync(temp, path);
      hardenFile(path);
    } finally {
      safeUnlink(temp);
    }
    metricsDirty = false;
  } catch {
    // Metrics persistence must never fail a model request. Keep the in-memory aggregate live.
    metricsDirty = true;
  }
}

function requestMetricsPersist(): void {
  metricsDirty = true;
  if (metricsBatchDepth === 0) persistMetricsNow();
}

export function readUltimateContextMetrics(): UltimateContextMetrics {
  ensureMetricsLoaded();
  return { ...metrics };
}

export function resetUltimateContextMetrics(): void {
  ensureMetricsLoaded();
  clearMetrics();
  requestMetricsPersist();
}

interface StoredEnvelope {
  version: 1;
  handle: string;
  createdAt: number;
  expiresAt: number;
  bytes: number;
  sha256: string;
  etag: string;
  contentBase64: string;
}

export interface StoredContextResult {
  handle: string;
  bytes: number;
  sha256: string;
  etag: string;
  expiresAt: number;
}

export interface ContextResultStoreOptions {
  rootDir: string;
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  retrievalMaxBytes?: number;
  now?: () => number;
  secret?: Uint8Array;
}

export type ContextResultRetrieval =
  | { ok: false; error: "invalid_handle" | "not_found" | "expired" | "invalid_offset" }
  | {
      ok: true;
      handle: string;
      etag: string;
      sha256: string;
      snapshotComplete: true;
      notModified: boolean;
      offset: number;
      nextOffset: number;
      totalBytes: number;
      hasMore: boolean;
      expiresAt: number;
      content?: string;
      contentBase64?: string;
      encoding?: "utf-8+base64";
    };

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function hardenDirectory(path: string): void {
  try { chmodSync(path, 0o700); } catch { /* chmod may be unavailable */ }
  if (process.platform === "win32") hardenSecretDir(path, { required: true });
}

function hardenFile(path: string): void {
  try { chmodSync(path, 0o600); } catch { /* chmod may be unavailable */ }
  if (process.platform === "win32") hardenSecretPath(path, { required: true });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); } catch (error) { if (!isMissing(error)) throw error; }
}

function writeExclusiveFile(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content, { encoding: "utf-8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  hardenFile(path);
}

function createSecret(rootDir: string): Uint8Array {
  const secretPath = join(rootDir, ".handle-key");
  if (!existsSync(secretPath)) {
    const temp = join(rootDir, `.handle-key.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeExclusiveFile(temp, randomBytes(32).toString("base64url"));
      try {
        linkSync(temp, secretPath);
        hardenFile(secretPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      safeUnlink(temp);
    }
  }
  const info = lstatSync(secretPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128) {
    throw new Error("Ultimate Context handle key is not a private regular file");
  }
  const encoded = readFileSync(secretPath, "utf-8").trim();
  const secret = Buffer.from(encoded, "base64url");
  if (secret.byteLength !== 32) throw new Error("Ultimate Context handle key is invalid");
  hardenFile(secretPath);
  return secret;
}

export class ContextResultStore {
  readonly rootDir: string;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly retrievalMaxBytes: number;
  private readonly now: () => number;
  private readonly secret: Uint8Array;

  constructor(options: ContextResultStoreOptions) {
    ensureMetricsLoaded();
    this.rootDir = options.rootDir;
    this.ttlMs = positiveInt(options.ttlMs, DEFAULT_TTL_MS);
    this.maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES);
    this.retrievalMaxBytes = positiveInt(options.retrievalMaxBytes, DEFAULT_RETRIEVAL_MAX_BYTES);
    this.now = options.now ?? Date.now;
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const rootInfo = lstatSync(this.rootDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("Ultimate Context store root is not a private directory");
    }
    hardenDirectory(this.rootDir);
    this.secret = options.secret ?? createSecret(this.rootDir);
    this.sweep();
    if (metricsDirty) requestMetricsPersist();
  }

  private entryPath(handle: string): string {
    return join(this.rootDir, `${handle}.json`);
  }

  private handleFor(content: Uint8Array): string {
    return `ctx_${createHmac("sha256", this.secret).update(content).digest("base64url")}`;
  }

  private readEnvelope(handle: string): StoredEnvelope | null {
    if (!HANDLE_PATTERN.test(handle)) return null;
    const path = this.entryPath(handle);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes * 2 + 65_536) return null;
      const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<StoredEnvelope>;
      if (value.version !== ENTRY_VERSION || value.handle !== handle) return null;
      if (!Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)
        || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0
        || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
        || value.etag !== `"sha256:${value.sha256}"`
        || typeof value.contentBase64 !== "string") return null;
      const content = Buffer.from(value.contentBase64, "base64");
      if (content.byteLength !== value.bytes
        || createHash("sha256").update(content).digest("hex") !== value.sha256) return null;
      return value as StoredEnvelope;
    } catch (error) {
      if (isMissing(error)) return null;
      return null;
    }
  }

  private removeEnvelope(envelope: StoredEnvelope, reason: "expired" | "evicted"): void {
    safeUnlink(this.entryPath(envelope.handle));
    if (reason === "expired") metrics.expiredEntries += 1;
    else {
      metrics.evictedEntries += 1;
      metrics.evictedBytes += envelope.bytes;
    }
  }

  sweep(): void {
    const now = this.now();
    const entries: StoredEnvelope[] = [];
    let totalBytes = 0;
    for (const name of readdirSync(this.rootDir)) {
      const match = /^(ctx_[A-Za-z0-9_-]{43})\.json$/.exec(name);
      if (!match) continue;
      const envelope = this.readEnvelope(match[1]);
      if (!envelope) continue;
      if (envelope.expiresAt <= now) {
        this.removeEnvelope(envelope, "expired");
        continue;
      }
      entries.push(envelope);
      totalBytes += envelope.bytes;
    }
    entries.sort((left, right) => left.createdAt - right.createdAt || left.handle.localeCompare(right.handle));
    while (entries.length > this.maxEntries || totalBytes > this.maxBytes) {
      const envelope = entries.shift();
      if (!envelope) break;
      this.removeEnvelope(envelope, "evicted");
      totalBytes -= envelope.bytes;
    }
  }

  put(content: string): StoredContextResult | null {
    ensureMetricsLoaded();
    const bytes = Buffer.from(content, "utf-8");
    if (bytes.byteLength > this.maxBytes) {
      metrics.storeRejected += 1;
      requestMetricsPersist();
      return null;
    }
    const handle = this.handleFor(bytes);
    // Dedupe is the overwhelmingly common path. A valid handle identifies immutable content, so
    // check it before the directory-wide sweep and do no cleanup or entry rewrite on a hit.
    const existing = this.readEnvelope(handle);
    if (existing && existing.expiresAt > this.now()) {
      metrics.storeHits += 1;
      const result = {
        handle,
        bytes: existing.bytes,
        sha256: existing.sha256,
        etag: existing.etag,
        expiresAt: existing.expiresAt,
      };
      requestMetricsPersist();
      return result;
    }
    // Replacing an expired envelope with identical content would otherwise hide that expiration
    // from the maintenance sweep: the atomic rename installs the fresh envelope at the same path
    // before sweep can observe the old one. Remove and account for the expired target exactly once.
    if (existing) this.removeEnvelope(existing, "expired");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const createdAt = this.now();
    const envelope: StoredEnvelope = {
      version: ENTRY_VERSION,
      handle,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      bytes: bytes.byteLength,
      sha256,
      etag: `"sha256:${sha256}"`,
      contentBase64: bytes.toString("base64"),
    };
    const target = this.entryPath(handle);
    const temp = join(this.rootDir, `.${handle}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeExclusiveFile(temp, JSON.stringify(envelope));
      renameSync(temp, target);
      hardenFile(target);
    } catch (error) {
      safeUnlink(temp);
      metrics.errors += 1;
      requestMetricsPersist();
      throw error;
    }
    metrics.storeWrites += 1;
    // Unique writes (and construction) are the maintenance boundary. This keeps TTL/count/byte
    // caps exact after every mutation without charging repeated dedupe hits for a full scan.
    this.sweep();
    if (!existsSync(target)) {
      metrics.storeRejected += 1;
      requestMetricsPersist();
      return null;
    }
    const result = { handle, bytes: envelope.bytes, sha256, etag: envelope.etag, expiresAt: envelope.expiresAt };
    requestMetricsPersist();
    return result;
  }

  get(handle: string, options: { offset?: number; maxBytes?: number; ifNoneMatch?: string } = {}): ContextResultRetrieval {
    ensureMetricsLoaded();
    metrics.retrievals += 1;
    if (!HANDLE_PATTERN.test(handle)) {
      metrics.invalidHandles += 1;
      requestMetricsPersist();
      return { ok: false, error: "invalid_handle" };
    }
    const envelope = this.readEnvelope(handle);
    if (!envelope) {
      requestMetricsPersist();
      return { ok: false, error: "not_found" };
    }
    if (envelope.expiresAt <= this.now()) {
      this.removeEnvelope(envelope, "expired");
      requestMetricsPersist();
      return { ok: false, error: "expired" };
    }
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > envelope.bytes) {
      requestMetricsPersist();
      return { ok: false, error: "invalid_offset" };
    }
    if (options.ifNoneMatch === envelope.etag) {
      metrics.notModified += 1;
      const result: ContextResultRetrieval = {
        ok: true,
        handle,
        etag: envelope.etag,
        sha256: envelope.sha256,
        snapshotComplete: true,
        notModified: true,
        offset,
        nextOffset: offset,
        totalBytes: envelope.bytes,
        hasMore: offset < envelope.bytes,
        expiresAt: envelope.expiresAt,
      };
      requestMetricsPersist();
      return result;
    }
    const requested = positiveInt(options.maxBytes, this.retrievalMaxBytes);
    const limit = Math.min(requested, this.retrievalMaxBytes);
    const content = Buffer.from(envelope.contentBase64, "base64");
    const end = Math.min(content.byteLength, offset + limit);
    const chunk = content.subarray(offset, end);
    const decoded = chunk.toString("utf-8");
    const validUtf8Chunk = Buffer.from(decoded, "utf-8").equals(chunk);
    metrics.retrievalBytes += chunk.byteLength;
    const result: ContextResultRetrieval = {
      ok: true,
      handle,
      etag: envelope.etag,
      sha256: envelope.sha256,
      snapshotComplete: true,
      notModified: false,
      offset,
      nextOffset: end,
      totalBytes: content.byteLength,
      hasMore: end < content.byteLength,
      expiresAt: envelope.expiresAt,
      ...(validUtf8Chunk ? { content: decoded } : {}),
      contentBase64: chunk.toString("base64"),
      encoding: "utf-8+base64",
    };
    requestMetricsPersist();
    return result;
  }
}

export interface UltimateContextControls {
  mode?: "off" | "auto" | "compact";
  intent?: "summary" | "errors" | "latest" | "structure";
  if_none_match?: string;
}

export interface UltimateContextTransformResult {
  transformedResults: number;
  bypassedResults: number;
  inputBytes: number;
  returnedBytes: number;
  savedBytes: number;
  latencyMs: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key === "_telemetry") continue;
    result[key] = stableValue((value as Record<string, unknown>)[key]);
  }
  return result;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function cleanOutput(output: unknown): unknown {
  if (typeof output !== "string") return stableValue(output);
  try { return stableStringify(JSON.parse(output)); } catch { return output; }
}

function serializedOutput(output: unknown): string {
  return typeof output === "string" ? output : stableStringify(output);
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const content = Buffer.from(text, "utf-8");
  if (content.byteLength <= maxBytes) return text;
  let end = Math.min(content.byteLength, maxBytes);
  while (end > 0 && end < content.byteLength && (content[end] & 0xc0) === 0x80) end -= 1;
  return content.subarray(0, end).toString("utf-8");
}

function utf8Suffix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const content = Buffer.from(text, "utf-8");
  if (content.byteLength <= maxBytes) return text;
  let start = Math.max(0, content.byteLength - maxBytes);
  while (start < content.byteLength && (content[start] & 0xc0) === 0x80) start += 1;
  return content.subarray(start).toString("utf-8");
}

function previewText(text: string, maxBytes: number, intent: UltimateContextControls["intent"]): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  const marker = "\n… [snapshot content omitted; use _context_result.retrieval] …\n";
  const markerBytes = Buffer.byteLength(marker, "utf-8");
  if (maxBytes <= markerBytes) return utf8Prefix(marker, maxBytes);
  const budget = maxBytes - markerBytes;
  if (intent === "latest") return marker + utf8Suffix(text, budget);
  if (intent === "errors") {
    const errors = text.split(/\r?\n/).filter(line => /\b(error|failed|failure|exception|fatal|denied)\b/i.test(line)).join("\n");
    if (errors) return utf8Prefix(errors, budget) + marker;
  }
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  return utf8Prefix(text, head) + marker + utf8Suffix(text, tail);
}

function compactTree(value: unknown, budget: number, intent: UltimateContextControls["intent"], depth = 0): unknown {
  if (typeof value === "string") return previewText(value, Math.max(128, budget), intent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const limit = Math.max(1, Math.min(value.length, Math.floor(budget / 256)));
    const selected = intent === "latest" ? value.slice(-limit) : value.slice(0, limit);
    const compacted = selected.map(item => compactTree(item, Math.max(128, Math.floor(budget / limit)), intent, depth + 1));
    if (selected.length < value.length) compacted.push({ omittedItems: value.length - selected.length });
    return compacted;
  }
  if (!value || typeof value !== "object") return value;
  if (depth >= 6) return { omitted: "nested value", type: "object" };
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  const perEntry = Math.max(128, Math.floor(budget / Math.max(1, entries.length)));
  for (const [key, child] of entries) out[key] = compactTree(child, perEntry, intent, depth + 1);
  return out;
}

function compactByAction(value: unknown, action: string, budget: number, intent: UltimateContextControls["intent"]): unknown {
  if (typeof value === "string") {
    try { return compactByAction(JSON.parse(value), action, budget, intent); } catch { return compactTree(value, budget, intent); }
  }
  if (!value || typeof value !== "object") return compactTree(value, budget, intent);
  const copy = stableValue(value) as Record<string, unknown>;
  const lower = action.toLowerCase();
  if (lower.includes("read_file") && typeof copy.content === "string") {
    copy.content = previewText(copy.content, budget, intent);
    return copy;
  }
  if (lower.includes("read_multiple_files") && Array.isArray(copy.files)) {
    const each = Math.max(256, Math.floor(budget / Math.max(1, copy.files.length)));
    copy.files = copy.files.map(file => compactByAction(file, "read_file", each, intent));
    return copy;
  }
  if (lower.includes("search") && Array.isArray(copy.results)) {
    const compacted = compactTree(copy.results, budget, intent) as unknown[];
    copy.results = compacted;
    copy.summaryResultCount = compacted.filter(item => !(item && typeof item === "object" && "omittedItems" in item)).length;
    return copy;
  }
  if (/(run_command|get_job_output|wait_jobs|run_commands_parallel|exec|terminal|shell)/.test(lower)) {
    const compactStreams = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(compactStreams);
      if (!node || typeof node !== "object") return node;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        out[key] = typeof child === "string" && /^(stdout|stderr|output|content)$/.test(key)
          ? previewText(child, Math.max(256, Math.floor(budget / 2)), intent ?? "latest")
          : compactStreams(child);
      }
      return out;
    };
    return compactStreams(copy);
  }
  return compactTree(copy, budget, intent);
}

function hasIncompleteFlag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasIncompleteFlag);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "truncated" || key.endsWith("_truncated") || key === "has_more") && child === true) return true;
    if ((key === "source_complete" || key === "complete") && child === false) return true;
    if (hasIncompleteFlag(child)) return true;
  }
  return false;
}

function sourceComplete(action: string, value: unknown): boolean {
  if (typeof value === "string") {
    try { return sourceComplete(action, JSON.parse(value)); } catch { return false; }
  }
  if (hasIncompleteFlag(value)) return false;
  if (!value || typeof value !== "object") return false;
  const lower = action.toLowerCase();
  const record = value as Record<string, unknown>;
  if (lower.includes("read_file") || lower.includes("search")) {
    return record.has_more === false && record.truncated === false;
  }
  if (/(run_command|exec|terminal|shell)/.test(lower)) {
    return record.stdout_truncated === false && record.stderr_truncated === false;
  }
  return record.source_complete === true;
}

function parseCallArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function actionForCall(item: Record<string, unknown>): string {
  const name = typeof item.name === "string" ? item.name : "unknown";
  const args = parseCallArguments(item.type === "custom_tool_call" ? item.input : item.arguments);
  return typeof args.action === "string" && args.action.trim() ? `${name}:${args.action.trim()}` : name;
}

function validControls(value: unknown): UltimateContextControls {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const mode = raw.mode === "off" || raw.mode === "auto" || raw.mode === "compact" ? raw.mode : undefined;
  const intent = raw.intent === "summary" || raw.intent === "errors" || raw.intent === "latest" || raw.intent === "structure"
    ? raw.intent : undefined;
  const ifNoneMatch = typeof raw.if_none_match === "string" && raw.if_none_match.length <= 128
    ? raw.if_none_match : undefined;
  return { ...(mode ? { mode } : {}), ...(intent ? { intent } : {}), ...(ifNoneMatch ? { if_none_match: ifNoneMatch } : {}) };
}

function isContextStub(output: unknown): boolean {
  if (typeof output !== "string") return false;
  try {
    const parsed = JSON.parse(output) as {
      _context_result?: Record<string, unknown>;
      not_modified?: unknown;
      snapshot_complete?: unknown;
      etag?: unknown;
    };
    const nested = parsed?._context_result;
    if (nested && nested.snapshot_complete === true) {
      // Accept our own HMAC handles and the Linux MCP's independently opaque `id` envelope.
      // The explicit completeness marker prevents arbitrary tool JSON from suppressing compaction.
      return (typeof nested.handle === "string" && HANDLE_PATTERN.test(nested.handle))
        || typeof nested.id === "string"
        || (nested.reduced === true && typeof nested.sha256 === "string");
    }
    // Linux MCP conditional result: already reduced to an ETag-only response.
    return parsed?.not_modified === true
      && parsed.snapshot_complete === true
      && typeof parsed.etag === "string";
  } catch { return false; }
}

export function applyUltimateContextInPlace(
  body: unknown,
  config: OcxUltimateContextConfig | undefined,
  store?: ContextResultStore,
): UltimateContextTransformResult {
  const started = performance.now();
  const result: UltimateContextTransformResult = {
    transformedResults: 0,
    bypassedResults: 0,
    inputBytes: 0,
    returnedBytes: 0,
    savedBytes: 0,
    latencyMs: 0,
  };
  if (config?.enabled !== true || config.mode === "off") return result;
  const input = (body as { input?: unknown } | null)?.input;
  if (!Array.isArray(input)) return result;
  ensureMetricsLoaded();
  metrics.transforms += 1;
  metricsBatchDepth += 1;
  const contextStore = store ?? contextStoreForConfig(config);
  const calls = new Map<string, string>();
  try {
    for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.call_id === "string") {
      calls.set(item.call_id, actionForCall(item));
      continue;
    }
    if ((item.type !== "function_call_output" && item.type !== "custom_tool_call_output") || typeof item.call_id !== "string") continue;
    const controls = validControls(item._context);
    delete item._context;
    const mode = controls.mode ?? config.mode ?? "auto";
    const action = calls.get(item.call_id) ?? "unknown";
    if (mode === "off" || action.toLowerCase().includes("get_context_result") || isContextStub(item.output)) {
      if (action.toLowerCase().includes("get_context_result")) {
        metrics.modelRequestedRetrievals += 1;
        const parsed = typeof item.output === "string" ? (() => { try { return JSON.parse(item.output) as Record<string, unknown>; } catch { return {}; } })() : {};
        if (parsed.not_modified === true || parsed.has_more === false) metrics.retrievalNoProgress += 1;
      }
      result.bypassedResults += 1;
      continue;
    }
    const cleaned = cleanOutput(item.output);
    item.output = cleaned;
    const snapshot = serializedOutput(cleaned);
    const inputBytes = Buffer.byteLength(snapshot, "utf-8");
    result.inputBytes += inputBytes;
    const threshold = positiveInt(config.thresholdBytes, DEFAULT_THRESHOLD_BYTES);
    if (mode === "auto" && inputBytes < threshold && !controls.if_none_match) {
      result.bypassedResults += 1;
      result.returnedBytes += inputBytes;
      continue;
    }
    const stored = contextStore.put(snapshot);
    if (!stored) {
      result.bypassedResults += 1;
      result.returnedBytes += inputBytes;
      continue;
    }
    const notModified = controls.if_none_match === stored.etag;
    const previewBytes = positiveInt(config.previewBytes, DEFAULT_PREVIEW_BYTES);
    const compacted = notModified ? undefined : compactByAction(cleaned, action, previewBytes, controls.intent);
    const payload = stableStringify({
      _context_result: {
        handle: stored.handle,
        etag: stored.etag,
        sha256: stored.sha256,
        snapshot_bytes: stored.bytes,
        snapshot_complete: true,
        source_complete: sourceComplete(action, cleaned),
        not_modified: notModified,
        expires_at: stored.expiresAt,
        manifest: {
          handle: stored.handle,
          etag: stored.etag,
          sha256: stored.sha256,
          source_complete: sourceComplete(action, cleaned),
          omitted: ["full_output", "unbounded_nested_values"],
          suggested_offset: 0,
          suggested_length: positiveInt(config.retrievalMaxBytes, DEFAULT_RETRIEVAL_MAX_BYTES),
          reason: sourceComplete(action, cleaned) ? "details_available_on_demand" : "source_incomplete_or_truncated",
        },
        retrieval: `run_command: ocx context get ${stored.handle} --offset 0 --max-bytes ${positiveInt(config.retrievalMaxBytes, DEFAULT_RETRIEVAL_MAX_BYTES)}`,
        retrieval_api: {
          tool: "get_context_result",
          context_id: stored.handle,
          offset: 0,
          length: positiveInt(config.retrievalMaxBytes, DEFAULT_RETRIEVAL_MAX_BYTES),
        },
      },
      action,
      ...(notModified ? {} : { summary: compacted }),
    });
    item.output = payload;
    const returnedBytes = Buffer.byteLength(payload, "utf-8");
    result.transformedResults += 1;
    result.returnedBytes += returnedBytes;
    result.savedBytes += Math.max(0, inputBytes - returnedBytes);
    }
    result.latencyMs = performance.now() - started;
    metrics.transformedResults += result.transformedResults;
    metrics.bypassedResults += result.bypassedResults;
    metrics.inputBytes += result.inputBytes;
    metrics.returnedBytes += result.returnedBytes;
    metrics.savedBytes += result.savedBytes;
    metrics.latencyMsTotal += result.latencyMs;
    metrics.latencyMsMax = Math.max(metrics.latencyMsMax, result.latencyMs);
    metricsDirty = true;
    return result;
  } finally {
    metricsBatchDepth = Math.max(0, metricsBatchDepth - 1);
    if (metricsBatchDepth === 0 && metricsDirty) persistMetricsNow();
  }
}

const stores = new Map<string, ContextResultStore>();

function contextStoreForConfig(config: OcxUltimateContextConfig = {}): ContextResultStore {
  const rootDir = join(getConfigDir(), "context-results");
  const key = JSON.stringify([
    rootDir,
    config.ttlMs,
    config.maxEntries,
    config.maxBytes,
    config.retrievalMaxBytes,
  ]);
  let store = stores.get(key);
  if (!store) {
    store = new ContextResultStore({
      rootDir,
      ttlMs: config.ttlMs,
      maxEntries: config.maxEntries,
      maxBytes: config.maxBytes,
      retrievalMaxBytes: config.retrievalMaxBytes,
    });
    stores.set(key, store);
  }
  return store;
}

export function getContextResult(
  handle: string,
  options: { offset?: number; maxBytes?: number; ifNoneMatch?: string } = {},
  config: OcxUltimateContextConfig = {},
): ContextResultRetrieval {
  return contextStoreForConfig(config).get(handle, options);
}

/** Wire/tool-friendly alias. */
export const get_context_result = getContextResult;
