/**
 * `ocx service` — run the proxy as a background service that auto-starts on login and
 * auto-restarts on crash. macOS → launchd; Windows → Task Scheduler; Linux → systemd user unit.
 * The service sets OCX_SERVICE=1 so the proxy's shutdown handler does NOT restore native
 * Codex on a service-managed restart (the restarted instance re-injects); explicit stop/uninstall
 * restore it via the command.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "./config";
import { restoreNativeCodex } from "./codex-inject";

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

function cliEntry(): { bun: string; cli: string } {
  // process.execPath = the bun binary; cli.ts sits next to this module.
  return { bun: process.execPath, cli: join(import.meta.dir, "cli.ts") };
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function logPath(): string {
  return join(getConfigDir(), "service.log");
}

export function buildPlist(): string {
  const { bun, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun}</string>
    <string>${cli}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OCX_SERVICE</key><string>1</string>
    <key>PATH</key><string>${path}</string>
  </dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// ── macOS (launchd) ──
function installLaunchd(): void {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  const p = plistPath();
  writeFileSync(p, buildPlist(), "utf8");
  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
  sh(`launchctl load -w "${p}"`);
}
function startLaunchd(): void { sh(`launchctl load -w "${plistPath()}"`); }
function stopLaunchd(): void { try { sh(`launchctl unload "${plistPath()}"`); } catch { /* not loaded */ } }
function statusLaunchd(): string { try { return sh(`launchctl list | grep ${LABEL} || true`); } catch { return ""; } }
function uninstallLaunchd(): void {
  const p = plistPath();
  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
  if (existsSync(p)) unlinkSync(p);
}

// ── Windows (Task Scheduler) ──
function installWindows(): void {
  const { bun, cli } = cliEntry();
  sh(`schtasks /create /tn ${TASK} /tr "\\"${bun}\\" \\"${cli}\\" start" /sc onlogon /rl highest /f`);
  sh(`schtasks /run /tn ${TASK}`);
}
function startWindows(): void { sh(`schtasks /run /tn ${TASK}`); }
function stopWindows(): void { try { sh(`schtasks /end /tn ${TASK}`); } catch { /* not running */ } }
function statusWindows(): string { try { return sh(`schtasks /query /tn ${TASK}`); } catch { return ""; } }
function uninstallWindows(): void { try { sh(`schtasks /delete /tn ${TASK} /f`); } catch { /* absent */ } }

// ── Linux (systemd user unit) ──
function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(): string {
  return join(unitDir(), `${TASK}.service`);
}

export function buildUnit(): string {
  const { bun, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  return `[Unit]
Description=OpenCodex Proxy Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${bun} ${cli} start
Restart=on-failure
RestartSec=5
Environment=OCX_SERVICE=1
Environment=PATH=${path}
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

function isSystemd(): boolean {
  try { execSync("systemctl --version", { stdio: "pipe" }); return true; } catch { return false; }
}

function installSystemd(): void {
  const dir = unitDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(unitPath(), buildUnit(), "utf8");
  sh("systemctl --user daemon-reload");
  sh(`systemctl --user enable --now ${TASK}`);
}
function startSystemd(): void { sh(`systemctl --user start ${TASK}`); }
function stopSystemd(): void { try { sh(`systemctl --user stop ${TASK}`); } catch { /* not running */ } }
function statusSystemd(): string { try { return sh(`systemctl --user status ${TASK}`); } catch { return ""; } }
function uninstallSystemd(): void {
  try { sh(`systemctl --user disable --now ${TASK}`); } catch { /* absent */ }
  if (existsSync(unitPath())) unlinkSync(unitPath());
  try { sh("systemctl --user daemon-reload"); } catch { /* best-effort */ }
}

type ServiceOps = {
  install: () => void; start: () => void; stop: () => void;
  status: () => string; uninstall: () => void;
};

function platformOps(): ServiceOps | null {
  if (process.platform === "darwin")
    return { install: installLaunchd, start: startLaunchd, stop: stopLaunchd, status: statusLaunchd, uninstall: uninstallLaunchd };
  if (process.platform === "win32")
    return { install: installWindows, start: startWindows, stop: stopWindows, status: statusWindows, uninstall: uninstallWindows };
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) {
      console.error("Docker detected. Run 'ocx start' directly instead of using the service manager.");
      process.exit(1);
    }
    if (!isSystemd()) {
      console.error("systemd not found. Run 'ocx start' under your process supervisor.");
      process.exit(1);
    }
    return { install: installSystemd, start: startSystemd, stop: stopSystemd, status: statusSystemd, uninstall: uninstallSystemd };
  }
  return null;
}

export function serviceCommand(sub?: string): void {
  const ops = platformOps();
  if (!ops) {
    console.error("ocx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
    process.exit(1);
  }
  switch (sub) {
    case "install":
      ops.install();
      console.log("✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).");
      if (process.platform === "linux") console.log("   For auto-start on boot: loginctl enable-linger $USER");
      break;
    case "start":
      ops.start();
      console.log("✅ service started.");
      break;
    case "stop":
      ops.stop();
      restoreNativeCodex();
      console.log("✅ service stopped + native Codex restored.");
      break;
    case "status": {
      const s = ops.status();
      console.log(s ? `✅ running:\n${s}` : "❌ service not installed/running.");
      break;
    }
    case "uninstall":
    case "remove":
      ops.uninstall();
      restoreNativeCodex();
      console.log("✅ service uninstalled + native Codex restored.");
      break;
    default:
      console.error("Usage: ocx service <install|start|stop|status|uninstall>");
      process.exit(1);
  }
}
