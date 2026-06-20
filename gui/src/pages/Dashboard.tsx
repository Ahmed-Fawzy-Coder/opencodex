import { useEffect, useState } from "react";
import { IconAlert, IconCheck, IconX } from "../icons";

interface HealthData { status: string; version: string; uptime: number }
interface ProviderInfo { name: string; adapter: string; baseUrl: string; defaultModel?: string; hasApiKey: boolean }
interface ModelInfo { id: string; provider: string; owned_by?: string }

export default function Dashboard({ apiBase }: { apiBase: string }) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [hRes, pRes] = await Promise.all([
          fetch(`${apiBase}/healthz`),
          fetch(`${apiBase}/api/providers`),
        ]);
        setHealth(await hRes.json());
        setProviders(await pRes.json());
        setError("");
      } catch {
        setError("Cannot connect to proxy. Is it running?");
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [apiBase]);

  useEffect(() => {
    if (error) return;
    setModelsLoading(true);
    fetch(`${apiBase}/api/models`)
      .then(r => r.json())
      .then((data: ModelInfo[]) => { setModels(data); setModelsLoading(false); })
      .catch(() => setModelsLoading(false));
  }, [apiBase, error]);

  if (error) {
    return (
      <div className="empty" style={{ marginTop: 40 }}>
        <IconAlert />
        <div className="title" style={{ color: "var(--red)" }}>{error}</div>
        <div style={{ fontSize: 13 }}>Run <code className="chip">ocx start</code> to start the proxy.</div>
      </div>
    );
  }

  const online = health?.status === "ok";

  return (
    <>
      <div className="page-head"><h2>Dashboard</h2></div>
      <p className="page-sub">Live status of the local opencodex proxy, its providers, and the models routed into Codex.</p>

      <div className="stat-row">
        <div className="stat">
          <div className="label">Status</div>
          <div className="value" style={{ display: "flex", alignItems: "center", gap: 9, color: online ? "var(--green)" : "var(--red)" }}>
            <span className={`dot ${online ? "dot-green" : "dot-red"}`} />{online ? "Online" : "Offline"}
          </div>
        </div>
        <div className="stat"><div className="label">Version</div><div className="value mono">{health?.version ?? "—"}</div></div>
        <div className="stat"><div className="label">Uptime</div><div className="value mono">{health ? `${Math.floor(health.uptime)}s` : "—"}</div></div>
        <div className="stat"><div className="label">Providers</div><div className="value">{providers.length}</div></div>
      </div>

      <div className="h-section">Active providers <span className="count">{providers.length}</span></div>
      {providers.length === 0 ? (
        <div className="empty">No providers configured. Run <code className="chip">ocx init</code>.</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Adapter</th><th>Base URL</th><th>Model</th><th>Auth</th></tr></thead>
            <tbody>
              {providers.map(p => (
                <tr key={p.name}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td><span className="chip">{p.adapter}</span></td>
                  <td className="muted mono" style={{ fontSize: 12 }}>{p.baseUrl}</td>
                  <td className="muted">{p.defaultModel ?? "—"}</td>
                  <td>{p.hasApiKey
                    ? <IconCheck style={{ width: 16, height: 16, color: "var(--green)" }} aria-label="key configured" />
                    : <IconX style={{ width: 16, height: 16, color: "var(--faint)" }} aria-label="no key" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="h-section">
        Available models <span className="count">{models.length}</span>
        {modelsLoading && <span className="spin" style={{ marginLeft: 4 }} />}
      </div>
      {models.length === 0 && !modelsLoading ? (
        <div className="empty">No models found. Check provider API keys.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(248px, 1fr))", gap: 10 }}>
          {models.map(m => (
            <div key={`${m.provider}/${m.id}`} className="model-card">
              <div className="id">{m.id}</div>
              <div className="prov">{m.provider}{m.owned_by ? ` · ${m.owned_by}` : ""}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
