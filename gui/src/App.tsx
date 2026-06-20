import { useEffect, useState } from "react";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Models from "./pages/Models";
import Subagents from "./pages/Subagents";
import Logs from "./pages/Logs";
import { IconGrid, IconServer, IconBoxes, IconBot, IconList, IconGithub, IconSun, IconMoon, IconMonitor } from "./icons";

type Page = "dashboard" | "providers" | "models" | "subagents" | "logs";
type Theme = "light" | "dark" | "system";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const THEME_KEY = "ocx-theme";

const NAV: { id: Page; label: string; Icon: typeof IconGrid }[] = [
  { id: "dashboard", label: "Dashboard", Icon: IconGrid },
  { id: "providers", label: "Providers", Icon: IconServer },
  { id: "models", label: "Models", Icon: IconBoxes },
  { id: "subagents", label: "Subagents", Icon: IconBot },
  { id: "logs", label: "Logs", Icon: IconList },
];

const THEME_ICON = { light: IconSun, dark: IconMoon, system: IconMonitor } as const;

function readStoredTheme(): Theme {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "system";
}

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  // Pin color-scheme via [data-theme]; "system" clears it so the OS preference applies (matches the
  // FOWT guard in index.html). Persisted so the choice survives reloads.
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") { el.removeAttribute("data-theme"); localStorage.removeItem(THEME_KEY); }
    else { el.setAttribute("data-theme", theme); localStorage.setItem(THEME_KEY, theme); }
  }, [theme]);

  const cycleTheme = () => setTheme(t => (t === "light" ? "dark" : t === "dark" ? "system" : "light"));
  const ThemeIcon = THEME_ICON[theme];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.png" alt="" />
          <span className="name">opencodex</span>
          <span className="ver">v0.0.1</span>
        </div>
        <nav>
          {NAV.map(({ id, label, Icon }) => (
            <button key={id} className={`nav-item${page === id ? " active" : ""}`} onClick={() => setPage(id)}
              aria-current={page === id ? "page" : undefined}>
              <Icon /> {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="theme-toggle" onClick={cycleTheme}
            aria-label={`Theme: ${theme}. Click to switch.`} title={`Theme: ${theme}`}>
            <ThemeIcon /> <span className="mode">{theme}</span>
          </button>
          <a className="sidebar-link" href="https://github.com/lidge-jun/opencodex" target="_blank" rel="noreferrer">
            <IconGithub /> GitHub
          </a>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          {page === "dashboard" && <Dashboard apiBase={API_BASE} />}
          {page === "providers" && <Providers apiBase={API_BASE} />}
          {page === "models" && <Models apiBase={API_BASE} />}
          {page === "subagents" && <Subagents apiBase={API_BASE} />}
          {page === "logs" && <Logs apiBase={API_BASE} />}
        </div>
      </main>
    </div>
  );
}
