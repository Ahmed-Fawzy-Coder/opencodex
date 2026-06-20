import type { OcxProviderConfig } from "../types";
import { deriveKeyLoginMap } from "../providers/derive";

/**
 * API-key "login" providers: not OAuth — the flow opens the provider's dashboard so the user can
 * create/copy a key, then validates + stores it as the provider's `apiKey` (authMode "key").
 * Most use the OpenAI-compatible chat API (`openai-chat` adapter, `Authorization: Bearer <key>`); a
 * few expose only an Anthropic-compatible endpoint and set `adapter: "anthropic"` (`x-api-key`).
 */
export interface KeyLoginProvider {
  label: string;
  baseUrl: string;
  adapter: string;
  /** Where the user creates/copies the API key. */
  dashboardUrl: string;
  models?: string[];
  defaultModel?: string;
  /**
   * Model ids that do NOT accept image input (the vision sidecar describes images for them) / do NOT
   * accept a reasoning param. Copied into the created provider config by `enrichProviderFromCatalog`,
   * so the classification actually gates the sidecars (matching is tolerant of an Ollama ":size" tag).
   */
  noVisionModels?: string[];
  noReasoningModels?: string[];
}

export const KEY_LOGIN_PROVIDERS: Record<string, KeyLoginProvider> = deriveKeyLoginMap();

/**
 * Copy a key-login catalog entry's seed/classification (`models`, `noVisionModels`,
 * `noReasoningModels`, `defaultModel`) onto a provider config being created, for any field the caller
 * didn't already supply. Lets the vision/reasoning classification actually reach the saved config
 * (the GUI/API only send adapter/baseUrl/apiKey/defaultModel). No-op for non-catalog provider names.
 */
export function enrichProviderFromCatalog(name: string, prov: OcxProviderConfig): void {
  const e = KEY_LOGIN_PROVIDERS[name];
  if (!e) return;
  if (!prov.models && e.models) prov.models = [...e.models];
  if (!prov.defaultModel && e.defaultModel) prov.defaultModel = e.defaultModel;
  if (!prov.noVisionModels && e.noVisionModels) prov.noVisionModels = [...e.noVisionModels];
  if (!prov.noReasoningModels && e.noReasoningModels) prov.noReasoningModels = [...e.noReasoningModels];
}

export function isKeyLoginProvider(name: string): boolean {
  return name in KEY_LOGIN_PROVIDERS;
}

export function listKeyLoginProviders(): Array<{ id: string } & KeyLoginProvider> {
  return Object.entries(KEY_LOGIN_PROVIDERS).map(([id, p]) => ({ id, ...p }));
}

/** Best-effort key validation: GET {baseUrl}/models with the key. Returns true/false/unknown. */
export async function validateApiKey(baseUrl: string, key: string): Promise<boolean | "unknown"> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    return "unknown";
  } catch {
    return "unknown";
  }
}
