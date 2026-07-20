import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_RESPONSE_STATE_MAX_BYTES = 32 * 1024 * 1024;
const RESPONSE_STATE_MAX_BYTES_ENV = "OPENCODEX_RESPONSE_STATE_MAX_BYTES";
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;

interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  conversationId?: string;
  cursorCheckpointUsable?: boolean;
}

const states = new Map<string, StoredResponseState>();
const stateBytes = new Map<string, number>();
let totalStateBytes = 0;
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

function responseStateMaxBytes(): number {
  const configured = Number(process.env[RESPONSE_STATE_MAX_BYTES_ENV]);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_RESPONSE_STATE_MAX_BYTES;
}

function serializedStateBytes(id: string, state: StoredResponseState): number | null {
  try {
    return Buffer.byteLength(JSON.stringify([id, state]), "utf-8");
  } catch {
    return null;
  }
}

function itemRecord(item: unknown): Record<string, unknown> | null {
  return item !== null && typeof item === "object" && !Array.isArray(item)
    ? item as Record<string, unknown>
    : null;
}

function toolCallId(item: unknown): string | undefined {
  const record = itemRecord(item);
  if (!record) return undefined;
  const type = record.type;
  if (typeof type !== "string" || !type.endsWith("_call")) return undefined;
  return typeof record.call_id === "string" && record.call_id.length > 0
    ? record.call_id
    : typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
}

function toolOutputId(item: unknown): string | null | undefined {
  const record = itemRecord(item);
  if (!record || typeof record.type !== "string") return undefined;
  const isOutput = record.type === "function_call_output"
    || record.type === "custom_tool_call_output"
    || record.type === "tool_search_output"
    || record.type.endsWith("_call_output");
  if (!isOutput) return undefined;
  return typeof record.call_id === "string" && record.call_id.length > 0 ? record.call_id : null;
}

function hasNoDanglingToolOutputs(items: unknown[], start: number): boolean {
  const calls = new Set<string>();
  for (let index = start; index < items.length; index += 1) {
    const callId = toolCallId(items[index]);
    if (callId) calls.add(callId);
    const outputId = toolOutputId(items[index]);
    if (outputId === null || (outputId !== undefined && !calls.has(outputId))) return false;
  }
  return true;
}

/** Keep the newest complete items when a single accumulated history exceeds the whole budget. */
function fitStateToBudget(
  id: string,
  state: StoredResponseState,
  maxBytes: number,
): { state: StoredResponseState; bytes: number } | null {
  const fullBytes = serializedStateBytes(id, state);
  if (fullBytes !== null && fullBytes <= maxBytes) return { state, bytes: fullBytes };

  // Find the longest suffix which fits without mutating or partially truncating an item. This
  // favors the newest continuation context; if even the newest item is individually too large,
  // metadata plus an empty history is retained when possible rather than retaining a huge value.
  let low = 0;
  let high = state.items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { ...state, items: state.items.slice(middle) };
    const bytes = serializedStateBytes(id, candidate);
    if (bytes !== null && bytes <= maxBytes) high = middle;
    else low = middle + 1;
  }
  // A size-only cut can strand function_call_output after dropping its matching function_call
  // (including parallel call groups). Move forward to the longest suffix whose outputs all have
  // a preceding call inside that suffix; dropping a whole pair is safer than replaying an invalid
  // tool sequence upstream.
  while (low < state.items.length && !hasNoDanglingToolOutputs(state.items, low)) low += 1;
  const fitted = { ...state, items: state.items.slice(low) };
  const bytes = serializedStateBytes(id, fitted);
  return bytes !== null && bytes <= maxBytes ? { state: fitted, bytes } : null;
}

function deleteState(id: string): void {
  if (!states.delete(id)) return;
  totalStateBytes -= stateBytes.get(id) ?? 0;
  stateBytes.delete(id);
}

function touchState(id: string, state: StoredResponseState): void {
  const bytes = stateBytes.get(id);
  if (bytes === undefined) return;
  states.delete(id);
  stateBytes.delete(id);
  states.set(id, state);
  stateBytes.set(id, bytes);
  // Reads alone do not schedule disk I/O. Any later rememberResponseState write persists the
  // updated LRU order; without a later write there is no new continuation state to protect.
}

function storeState(id: string, state: StoredResponseState): boolean {
  deleteState(id);
  const maxBytes = responseStateMaxBytes();
  const fitted = fitStateToBudget(id, state, maxBytes);
  if (!fitted) return false;
  while (states.size >= MAX_STORED_RESPONSES || totalStateBytes + fitted.bytes > maxBytes) {
    const oldest = states.keys().next().value;
    if (typeof oldest !== "string") break;
    deleteState(oldest);
  }
  states.set(id, fitted.state);
  stateBytes.set(id, fitted.bytes);
  totalStateBytes += fitted.bytes;
  return true;
}

/**
 * Best-effort disk snapshot so previous_response_id chains survive a proxy restart (the
 * dominant expansion-miss cause: an in-memory-only store dies with the process, and the next
 * chained turn then reaches the upstream as a naked delta). Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const path = snapshotPath();
    if (!existsSync(path)) return;
    const snapshotInfo = lstatSync(path);
    if (!snapshotInfo.isFile() || snapshotInfo.isSymbolicLink()
      || snapshotInfo.size > SNAPSHOT_TOTAL_MAX_BYTES + 64 * 1024) return;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.states)) return;
    const candidates: Array<[string, StoredResponseState]> = [];
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, state] = entry as [unknown, unknown];
      if (typeof id !== "string" || !state || typeof state !== "object") continue;
      const rec = state as StoredResponseState;
      if (typeof rec.createdAt !== "number" || !Array.isArray(rec.items)) continue;
      if (now() - rec.createdAt > RESPONSE_TTL_MS) continue;
      candidates.push([id, rec]);
    }
    // Admit newest entries first so a large/old snapshot cannot crowd out the latest chain, then
    // restore oldest-to-newest Map order for deterministic LRU eviction.
    const admitted: Array<[string, StoredResponseState, number]> = [];
    const admittedIds = new Set<string>();
    const maxBytes = responseStateMaxBytes();
    let admittedBytes = 0;
    for (const [id, state] of candidates.reverse()) {
      if (admitted.length >= MAX_STORED_RESPONSES) break;
      if (admittedIds.has(id)) continue;
      const fitted = fitStateToBudget(id, state, maxBytes - admittedBytes);
      if (!fitted) continue;
      admitted.push([id, fitted.state, fitted.bytes]);
      admittedIds.add(id);
      admittedBytes += fitted.bytes;
      if (admittedBytes >= maxBytes) break;
    }
    for (const [id, state, bytes] of admitted.reverse()) {
      states.set(id, state);
      stateBytes.set(id, bytes);
    }
    totalStateBytes = admittedBytes;
    pruneResponses();
  } catch {
    /* missing/corrupt snapshot: start empty */
  }
}

function persistNow(path: string): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  try {
    const entries: [string, StoredResponseState][] = [];
    let total = 0;
    // Newest-first so the most recent chains survive both caps.
    for (const entry of [...states].reverse()) {
      const size = Buffer.byteLength(JSON.stringify(entry), "utf-8");
      if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
      if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
      total += size;
      entries.push(entry);
    }
    entries.reverse();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies on creation — re-harden an existing config dir so the
    // conversation-content snapshot never lands in a group/world-readable directory.
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    atomicWriteFile(path, JSON.stringify({ version: 1, states: entries }));
  } catch {
    /* best-effort: disk trouble must never affect request handling */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  // Resolve the target path NOW: tests (and anything else) may swap OPENCODEX_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  pendingPersistPath = snapshotPath();
  const path = pendingPersistPath;
  persistTimer = setTimeout(() => persistNow(path), SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export function flushResponseState(): void {
  if (!persistTimer) return;
  // Use the path captured when the write was scheduled — OPENCODEX_HOME may have moved since.
  persistNow(pendingPersistPath ?? snapshotPath());
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(at = now()): void {
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS) deleteState(id);
  }
  const maxBytes = responseStateMaxBytes();
  while (states.size > MAX_STORED_RESPONSES || totalStateBytes > maxBytes) {
    const oldest = states.keys().next().value;
    if (typeof oldest !== "string") break;
    deleteState(oldest);
  }
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) return body;
  const expandedItems = [...previous.items, ...inputItems(request.input)];
  // A pending call can itself be the oversized item that was dropped. In that case the next turn's
  // output still must not be locally expanded into a dangling tool result; fall back to the original
  // previous_response_id request, matching the normal cache-miss behavior.
  if (!hasNoDanglingToolOutputs(expandedItems, 0)) return body;
  touchState(previousId, previous);
  return {
    ...request,
    input: expandedItems,
  };
}

export function previousResponseConversationId(responseId: string | undefined): string | undefined {
  if (!responseId) return undefined;
  ensureLoaded();
  pruneResponses();
  const state = states.get(responseId);
  if (state) touchState(responseId, state);
  return state?.conversationId;
}

export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown },
  conversationId?: string,
  opts?: { force?: boolean },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store stays in-memory with a 1h TTL, so this is a proxy-internal continuation cache, not
  // real server-side response storage.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  pruneResponses();
  const stored = storeState(response.id, {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
    // Always preserve the Cursor conversation id so the next tool-result turn can continue the SAME
    // Cursor conversation (multi-turn continuation). Separately track whether Cursor's own
    // checkpoint/cache is safe to reuse: a turn that ended with a pending client tool call produced an
    // incomplete agent turn on the Cursor side (we suspended without a real mcpResult), so its
    // checkpoint must not be reused — but the conversation id string itself is still valid.
    ...(conversationId ? { conversationId } : {}),
    cursorCheckpointUsable: !response.output.some(item => {
      return !!item && typeof item === "object" && (item as { type?: unknown }).type === "function_call";
    }),
  });
  if (stored) schedulePersist();
}

/** Memory-only reset (simulates a process restart: the snapshot file survives). */
export function clearResponseStateMemoryForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  states.clear();
  stateBytes.clear();
  totalStateBytes = 0;
  loaded = false;
}

export function responseStateStatsForTests(): { entries: number; bytes: number; maxBytes: number } {
  ensureLoaded();
  pruneResponses();
  return { entries: states.size, bytes: totalStateBytes, maxBytes: responseStateMaxBytes() };
}

export function clearResponseStateForTests(): void {
  clearResponseStateMemoryForTests();
  try {
    unlinkSync(snapshotPath());
  } catch {
    /* no snapshot on disk */
  }
}
