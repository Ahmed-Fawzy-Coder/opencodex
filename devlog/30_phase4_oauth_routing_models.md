# Phase 4 — OAuth Passthrough + Provider Routing + Model Namespacing

Status: PLAN (awaiting approval)
Date: 2026-06-18
Work class: C4 (auth/credential forwarding is security-sensitive → full PABCD + audit)

## 1. Problem (verified)

Codex routes **every** model (incl. `gpt-5.5`) through the custom `opencodex`
provider at `http://localhost:10100/v1/responses`. Two live failures:

- `gpt-*` and every non-`kimi` opencode model (`deepseek-v4-pro`, `glm-5.2`, …)
  return **401 "Missing bearer or basic authentication"** (cf-ray = OpenAI/Cloudflare edge).
- Root cause: the `openai` provider's key is `${OPENAI_API_KEY}`, which is **empty**
  (user logs into Codex via ChatGPT OAuth, `auth_mode=chatgpt`, no API key). The proxy
  forwards to `api.openai.com` with **no auth**, and the router **falls back any
  unrecognized model to this keyless `openai` provider**.

### Decisive evidence (header capture, `codex_exec/0.141.0`)
Codex already sends its OAuth credential to the custom provider on **every** request:
```
authorization: Bearer eyJ… (2090-char JWT)
chatgpt-account-id: e48e01c4-…
originator: codex_exec
x-codex-turn-metadata: {...}
```
The proxy **receives** the token and **throws it away**, substituting the empty key.
Fix = forward it instead of dropping it.

### Codex source facts (`~/developer/codex/openai-codex/codex-rs`)
- ChatGPT-auth Responses endpoint = `https://chatgpt.com/backend-api/codex/responses`
  (`chatgpt_base_url` default `https://chatgpt.com/backend-api/` — `core/src/config/mod.rs:890`).
  NOT `api.openai.com`.
- API-key auth endpoint = `https://api.openai.com/v1/responses`.
- Codex's `/model` picker is driven by `model_catalog_json`; the proxy currently
  returns `{"models":[]}` to Codex clients (`server.ts:266-268`).

## 2. Requirements (confirmed in interview)

1. `gpt-5.5/5.4/5.2/5.3-codex/5.3-codex-spark` (and any `gpt-*`) → pass through with
   Codex's **incoming** OAuth headers, verbatim, to the ChatGPT backend.
2. All other models → `opencode-go` with its configured API key.
3. Unknown model (not `gpt-*`, no namespace match) → fallback to **`opencode-go`** ("go").
4. Model IDs may be **provider-namespaced**: `opencode-go/deepseek-v4-pro`
   (same model name can come from multiple providers). Router splits `provider/model`.
5. `/models` shows native gpt + go models **namespaced per provider**, on BOTH
   the proxy endpoint (`/v1/models`, incl. the Codex-client path) AND the Codex
   catalog file (`model_catalog_json`).
6. Smoke (must both pass before reporting): `gpt-5.5` works via OAuth passthrough AND
   `deepseek-v4-pro` works via the go key — through Codex **and** via direct proxy curl;
   `/models` returns the merged namespaced list.

### Security invariant (audit-critical)
`authMode:"forward"` is **opt-in per provider** and enabled **only** for the
OpenAI/ChatGPT provider. opencode-go keeps using `openai-chat` (sets its OWN
`Authorization: Bearer <apiKey>`), so Codex's OAuth token is **never** forwarded to
opencode.ai.

## 3. Design

### Routing (`router.ts`)
```
routeModel(modelId):
  0. if modelId == "<prov>/<rest>" and providers[prov] exists
        → route to prov, upstream modelId = "<rest>"        # namespace split (NEW)
  1. provider.defaultModel == modelId  → that provider       # (existing)
  2. provider.models includes modelId  → that provider       # (existing)
  3. gpt-/o1-/o3-/o4- prefix → provider "openai"             # (existing)
  4. else → config.defaultProvider                           # (existing; now = opencode-go)
```
Bare `glm-5.2` / `deepseek-v4-pro` resolve via step 4 → opencode-go. Namespaced
`opencode-go/deepseek-v4-pro` resolves via step 0. Both work.

### Auth forwarding (`openai-responses.ts` + `base.ts` + `server.ts`)
- Extend adapter `buildRequest(parsed, incoming?)` with the incoming request headers.
- openai-responses, when `provider.authMode === "forward"`: copy `authorization`,
  `chatgpt-account-id`, `openai-beta`, `originator`, `session_id` from `incoming`;
  do NOT use `apiKey`; URL = `${baseUrl}/responses` (baseUrl = chatgpt backend).
  When `authMode !== "forward"` (api-key): URL = `${baseUrl}/v1/responses`,
  `Authorization: Bearer <apiKey>` (existing behavior preserved).

### Models surface
- `fetchAllModels` returns `{ id, provider, owned_by }` (bare id) — unchanged shape,
  plus a derived `namespaced = "<provider>/<id>"` used by the endpoints.
- `/v1/models` (normal client): `data[].id = "<provider>/<id>"` for go models +
  native gpt slugs (bare).
- `/v1/models?client_version` (Codex client): return `{models:[…]}` populated (was `[]`).
- `codex-catalog.ts` (NEW): merge go entries (slug `opencode-go/<id>`) into the
  on-disk `model_catalog_json`, preserving native entries, idempotent.

## 4. File changes (diff-level)

### MODIFY `src/types.ts`
```diff
 export interface OcxProviderConfig {
   adapter: string;
   baseUrl: string;
   apiKey?: string;
   defaultModel?: string;
   models?: string[];
   headers?: Record<string, string>;
+  /** "key" (default) = use apiKey; "forward" = relay caller's incoming auth headers (OAuth passthrough). */
+  authMode?: "key" | "forward";
 }
```

### MODIFY `src/adapters/base.ts`
```diff
-  buildRequest(parsed: OcxParsedRequest): {
+  buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta): {
     url: string; method: string; headers: Record<string, string>; body: string;
   };
+}
+export interface IncomingMeta {
+  headers: Headers;
 }
```
(Add `IncomingMeta` import to each adapter signature; anthropic/google/azure/openai-chat
ignore the 2nd arg — additive, non-breaking.)

### MODIFY `src/adapters/openai-responses.ts`
```diff
-    buildRequest(parsed: OcxParsedRequest) {
-      const url = `${provider.baseUrl}/v1/responses`;
-      const headers: Record<string, string> = { "Content-Type": "application/json" };
-      if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
-      if (provider.headers) Object.assign(headers, provider.headers);
-      return { url, method: "POST", headers, body: JSON.stringify(parsed._rawBody) };
+    buildRequest(parsed: OcxParsedRequest, incoming?: { headers: Headers }) {
+      const headers: Record<string, string> = { "Content-Type": "application/json" };
+      let url: string;
+      if (provider.authMode === "forward") {
+        url = `${provider.baseUrl}/responses`;          // chatgpt backend, no /v1
+        const fwd = ["authorization", "chatgpt-account-id", "openai-beta", "originator", "session_id"];
+        for (const h of fwd) {
+          const v = incoming?.headers.get(h);
+          if (v) headers[h] = v;
+        }
+      } else {
+        url = `${provider.baseUrl}/v1/responses`;        // api-key path (unchanged)
+        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
+      }
+      if (provider.headers) Object.assign(headers, provider.headers);
+      return { url, method: "POST", headers, body: JSON.stringify(parsed._rawBody) };
     },
```

### MODIFY `src/router.ts` — add namespace split at top of `routeModel`
```diff
 export function routeModel(config: OcxConfig, modelId: string): RouteResult {
+  // 0. Explicit "<provider>/<model>" namespace
+  const slash = modelId.indexOf("/");
+  if (slash > 0) {
+    const provName = modelId.slice(0, slash);
+    const prov = config.providers[provName];
+    if (prov) {
+      return { providerName: provName,
+        provider: { ...prov, apiKey: resolveEnvValue(prov.apiKey) },
+        modelId: modelId.slice(slash + 1) };
+    }
+  }
   for (const [provName, prov] of Object.entries(config.providers)) {
     if (prov.defaultModel === modelId) { … }              // unchanged
```
(Steps 1-4 unchanged. Fallback already returns `config.defaultProvider`.)

### MODIFY `src/server.ts`
- `handleResponses`: pass incoming headers to both buildRequest calls:
```diff
-    const request = adapter.buildRequest(parsed);
+    const request = adapter.buildRequest(parsed, { headers: req.headers });
```
(both passthrough branch and the bridged branch). Also set request-log `model = parsed.modelId`, `provider = route.providerName`.
- `fetchAllModels`: include `namespaced: \`${name}/${m.id}\``.
- `/v1/models`: namespaced ids for normal clients; Codex-client branch returns
  `{ models: buildCodexModelPresets(...) }` instead of `{ models: [] }`.

### NEW `src/codex-catalog.ts` (~120 lines)
- `readCodexCatalogPath()`: parse `model_catalog_json = "…"` from `~/.codex/config.toml`
  (fallback `~/.codex/opencodex-catalog.json`).
- `syncCatalogModels(config)`: read existing catalog `{models:[…]}`, build go entries
  (`slug: "opencode-go/<id>"`, `display_name`, `description`, `default_reasoning_level:"medium"`,
  `supported_reasoning_levels`, `shell_type:"shell_command"`, `visibility:"list"`,
  `supported_in_api:true`, `priority:5`), drop previously ocx-injected entries
  (tagged), append fresh ones, write back. Idempotent.

### MODIFY `src/cli.ts`
```diff
 async function syncModelsToCodex(port?: number) {
   const config = loadConfig();
   const p = port ?? config.port ?? 10100;
   const { injectCodexConfig } = await import("./codex-inject");
   const result = await injectCodexConfig(p, config);
+  const { syncCatalogModels } = await import("./codex-catalog");
+  await syncCatalogModels(config).catch(e => console.error("catalog sync:", e));
   console.log(result.message);
   return result;
 }
```

### MODIFY `src/config.ts` `getDefaultConfig()`
Default `openai` provider → `authMode:"forward"`, `baseUrl:"https://chatgpt.com/backend-api/codex"`,
no apiKey (works with Codex OAuth out of the box). `defaultProvider` stays `openai`.

### RUNTIME (not a repo file) — `~/.opencodex/config.json`
```json
{
  "port": 10100,
  "providers": {
    "openai": { "adapter": "openai-responses", "baseUrl": "https://chatgpt.com/backend-api/codex", "authMode": "forward" },
    "opencode-go": { "adapter": "openai-chat", "baseUrl": "https://opencode.ai/zen/go/v1", "apiKey": "<existing>", "defaultModel": "kimi-k2.6" }
  },
  "defaultProvider": "opencode-go"
}
```

## 5. Smoke plan (both must pass)
1. Restart proxy (`ocx stop && ocx start`).
2. Direct curl: `POST /v1/responses {model:"deepseek-v4-pro"}` → 200 + content (go key).
3. `codex exec -m gpt-5.5 "say SMOKE_OK"` → real answer (OAuth passthrough to chatgpt backend).
4. `codex exec -m deepseek-v4-pro "say SMOKE_OK"` → real answer.
5. `GET /v1/models` → contains `opencode-go/deepseek-v4-pro` + gpt slugs.
6. Codex `/model` picker loads catalog without error.

## 6. Risks
- **Exact chatgpt backend path** (`/backend-api/codex/responses`) is config-driven and
  empirically verified in smoke step 3; adjust baseUrl if 404/wrong path.
- **Catalog schema**: minimal entries must satisfy Codex's parser — validated in smoke step 6.
- **Token leak**: forward mode is per-provider, openai-only; opencode-go overwrites auth. (audit)

## 7. Audit resolutions (Backend A-phase, 2026-06-18)

Audit verdict PASS with required fixes — folded in:

- **F5/F6** `getDefaultConfig()` is the **fresh-install default** (no secrets): `openai`
  forward-mode + `defaultProvider:"openai"`. The "unknown → go" fallback is the
  **user's runtime choice**, applied by migrating `~/.opencodex/config.json`
  (`defaultProvider:"opencode-go"` + opencode-go block with key). Two different contexts,
  not a contradiction.
- **F7/F12** Single source of truth `buildCatalogEntries(gptSlugs, goModels)` exported from
  `codex-catalog.ts`. Reused by BOTH `syncCatalogModels` (disk) and the
  `/v1/models?client_version` Codex-client branch. No duplicate builder.
- **F8** ChatGPT backend has no `GET /models`. Native gpt list = static constant
  `NATIVE_OPENAI_MODELS = ["gpt-5.5","gpt-5.4","gpt-5.2","gpt-5.3-codex","gpt-5.3-codex-spark"]`
  in `codex-catalog.ts`. `fetchAllModels` skips `authMode:"forward"` providers (can't query);
  gpt entries come from the static list.
- **F9** `/api/models` gains a `namespaced` field too (kept `id` bare + `provider`).
- **F10** Injected catalog entries are identified by namespaced slug containing `"/"`
  (native gpt slugs never contain `/`). Re-sync removes slugs containing `/` then re-appends.
  No non-schema tag field added to the catalog.
- **F11** Back up catalog to `~/.opencodex/catalog-backup.json` before each write.
- **F1** Forward mode is implemented ONLY in `openai-responses.ts`; `openai-chat` (opencode-go)
  always sets its own `Authorization: Bearer <apiKey>`. Adapter-scoped invariant documented.
- **F2** Apply `provider.headers` FIRST, then forwarded auth headers, so the OAuth header
  is never overwritten by static provider headers.
- **F3** Optional 2nd `incoming` param is assignable in TS (fewer-param fns satisfy the type);
  other adapters need no signature edit. Verified by `tsc`.
- **F4** Namespace split triggers ONLY when prefix matches a configured provider name; with
  the current 2-provider config there is no OpenRouter collision. Acceptable.
