#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SERVICE_ID = "io.github.kiettt8-product.figma-ui-mcp-bridge";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdEscape(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function vbsEscape(value) {
  return String(value).replaceAll('"', '""');
}

function executableOnPath(name, env = process.env, platform = process.platform) {
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === "win32" ? name + extension : name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeManagedFile(filePath, content, {
  dryRun = false,
  mode = 0o600,
  log = console.log,
} = {}) {
  const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  if (current === content) {
    log(`  Already installed: ${filePath}`);
    return { changed: false, filePath, backupPath: null };
  }
  if (dryRun) {
    log(`  DRY RUN: would write ${filePath}`);
    return { changed: true, filePath, backupPath: null };
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  let backupPath = null;
  if (current !== null) {
    backupPath = `${filePath}.backup-${stamp()}`;
    copyFileSync(filePath, backupPath);
  }
  writeFileSync(filePath, content, { encoding: "utf8", mode });
  log(`  Installed: ${filePath}`);
  if (backupPath) log(`  Backup:    ${backupPath}`);
  return { changed: true, filePath, backupPath };
}

export function buildMacLaunchAgent({
  nodePath,
  daemonPath,
  repoRoot = REPO_ROOT,
  stdoutPath,
  stderrPath,
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>-i</string>
    <string>PATH=/usr/bin:/bin:/usr/sbin:/sbin</string>
    <string>FIGMA_MCP_HOST=127.0.0.1</string>
    <string>FIGMA_MCP_PORT=38451</string>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(daemonPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

export function buildLinuxSystemdUnit({
  nodePath,
  daemonPath,
  repoRoot = REPO_ROOT,
}) {
  return `[Unit]
Description=Figma UI MCP local bridge
After=default.target

[Service]
Type=simple
ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin FIGMA_MCP_HOST=127.0.0.1 FIGMA_MCP_PORT=38451 "${systemdEscape(nodePath)}" "${systemdEscape(daemonPath)}"
WorkingDirectory="${systemdEscape(repoRoot)}"
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export function buildWindowsStartupScript({ nodePath, daemonPath }) {
  const command = `"${nodePath}" "${daemonPath}"`;
  return `Set shell = CreateObject("WScript.Shell")\r
shell.Run "${vbsEscape(command)}", 0, False\r
`;
}

function runChecked(command, args, { ignoreFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ignoreFailure ? "ignore" : ["ignore", "pipe", "pipe"],
  });
  if (!ignoreFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

async function runCheckedWithRetry(command, args, {
  attempts = 5,
  delayMs = 300,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return runChecked(command, args);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

function waitForBridge({ timeoutMs = 10_000, port = 38451 } = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(
        { hostname: "127.0.0.1", port, path: "/health", timeout: 700 },
        response => {
          let data = "";
          response.on("data", chunk => { data += chunk; });
          response.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              retry();
            }
          });
        },
      );
      request.on("error", retry);
      request.on("timeout", () => {
        request.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Background bridge did not become ready on port ${port}.`));
        return;
      }
      setTimeout(check, 300);
    };
    check();
  });
}

export async function installBackgroundService({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  nodePath = process.execPath,
  daemonPath = path.join(REPO_ROOT, "server", "bridge-daemon.js"),
  dryRun = false,
  log = console.log,
} = {}) {
  if (!existsSync(daemonPath)) throw new Error(`Bridge daemon not found: ${daemonPath}`);

  if (platform === "darwin") {
    const logsDir = path.join(home, "Library", "Logs", "FigmaUIMCP");
    const plistPath = path.join(home, "Library", "LaunchAgents", `${SERVICE_ID}.plist`);
    const content = buildMacLaunchAgent({
      nodePath,
      daemonPath,
      stdoutPath: path.join(logsDir, "bridge.log"),
      stderrPath: path.join(logsDir, "bridge.error.log"),
    });
    if (!dryRun) mkdirSync(logsDir, { recursive: true });
    const writeResult = writeManagedFile(plistPath, content, { dryRun, log });
    if (dryRun) return { status: "dry-run", platform, ...writeResult };

    const domain = `gui/${process.getuid()}`;
    runChecked("launchctl", ["bootout", `${domain}/${SERVICE_ID}`], { ignoreFailure: true });
    await runCheckedWithRetry("launchctl", ["bootstrap", domain, plistPath]);
    await runCheckedWithRetry("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_ID}`]);
    const health = await waitForBridge();
    log(`  Running:   http://127.0.0.1:38451`);
    return { status: "installed", platform, health, ...writeResult };
  }

  if (platform === "linux") {
    const unitPath = path.join(
      env.XDG_CONFIG_HOME || path.join(home, ".config"),
      "systemd",
      "user",
      "figma-ui-mcp-bridge.service",
    );
    const content = buildLinuxSystemdUnit({ nodePath, daemonPath });
    const writeResult = writeManagedFile(unitPath, content, { dryRun, log });
    if (dryRun) return { status: "dry-run", platform, ...writeResult };

    runChecked("systemctl", ["--user", "daemon-reload"]);
    runChecked("systemctl", ["--user", "enable", "--now", "figma-ui-mcp-bridge.service"]);
    runChecked("systemctl", ["--user", "restart", "figma-ui-mcp-bridge.service"]);
    const health = await waitForBridge();
    log(`  Running:   http://127.0.0.1:38451`);
    return { status: "installed", platform, health, ...writeResult };
  }

  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    const startupPath = path.join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "Figma UI MCP Bridge.vbs",
    );
    const content = buildWindowsStartupScript({ nodePath, daemonPath });
    const writeResult = writeManagedFile(startupPath, content, { dryRun, log });
    if (dryRun) return { status: "dry-run", platform, ...writeResult };

    const child = spawn(nodePath, [daemonPath], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        FIGMA_MCP_HOST: "127.0.0.1",
        FIGMA_MCP_PORT: "38451",
        PATH: env.PATH || "",
      },
    });
    child.unref();
    const health = await waitForBridge();
    log(`  Running:   http://127.0.0.1:38451`);
    return { status: "installed", platform, health, ...writeResult };
  }

  throw new Error(`Background startup is not supported on platform: ${platform}`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const dryRun = process.argv.includes("--dry-run");
  const nodePath = executableOnPath("node") || process.execPath;
  installBackgroundService({ dryRun, nodePath })
    .catch(error => {
      console.error(`Background setup failed: ${error.message}`);
      process.exitCode = 1;
    });
}
