#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

export const SERVER_NAME = "figma-ui-mcp";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function executableOnPath(name, env = process.env, platform = process.platform) {
  const pathValue = env.PATH || "";
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, platform === "win32" ? name + extension : name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue searching.
      }
    }
  }
  return null;
}

function appExists(paths) {
  return paths.some(candidate => existsSync(candidate));
}

function platformPaths({ home, platform, env }) {
  const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, ".config");

  if (platform === "darwin") {
    return {
      claudeDesktop: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      vscode: path.join(home, "Library", "Application Support", "Code", "User", "mcp.json"),
      apps: {
        codex: ["/Applications/ChatGPT.app", "/Applications/Codex.app"],
        claudeDesktop: ["/Applications/Claude.app"],
        cursor: ["/Applications/Cursor.app"],
        vscode: ["/Applications/Visual Studio Code.app"],
        windsurf: ["/Applications/Windsurf.app", "/Applications/Devin.app"],
      },
    };
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return {
      claudeDesktop: path.join(appData, "Claude", "claude_desktop_config.json"),
      vscode: path.join(appData, "Code", "User", "mcp.json"),
      apps: {
        codex: [
          path.join(localAppData, "Programs", "ChatGPT"),
          path.join(localAppData, "Programs", "Codex"),
        ],
        claudeDesktop: [path.join(localAppData, "Programs", "Claude")],
        cursor: [path.join(localAppData, "Programs", "cursor")],
        vscode: [path.join(localAppData, "Programs", "Microsoft VS Code")],
        windsurf: [path.join(localAppData, "Programs", "Windsurf")],
      },
    };
  }

  return {
    claudeDesktop: path.join(xdgConfig, "Claude", "claude_desktop_config.json"),
    vscode: path.join(xdgConfig, "Code", "User", "mcp.json"),
    apps: {
      codex: [],
      claudeDesktop: [],
      cursor: [],
      vscode: [],
      windsurf: [],
    },
  };
}

export function resolveClients({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const locations = platformPaths({ home, platform, env });
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");

  const clients = [
    {
      id: "codex",
      label: "Codex / ChatGPT desktop",
      kind: "toml",
      configPath: path.join(codexHome, "config.toml"),
      rootKey: null,
      detected: false,
    },
    {
      id: "claude-code",
      label: "Claude Code",
      kind: "json",
      configPath: path.join(home, ".claude.json"),
      rootKey: "mcpServers",
      detected: false,
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      kind: "json",
      configPath: locations.claudeDesktop,
      rootKey: "mcpServers",
      detected: false,
    },
    {
      id: "cursor",
      label: "Cursor",
      kind: "json",
      configPath: path.join(home, ".cursor", "mcp.json"),
      rootKey: "mcpServers",
      detected: false,
    },
    {
      id: "vscode",
      label: "Visual Studio Code",
      kind: "json",
      configPath: locations.vscode,
      rootKey: "servers",
      detected: false,
      includeType: true,
    },
    {
      id: "windsurf",
      label: "Windsurf / Devin Cascade",
      kind: "json",
      configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      rootKey: "mcpServers",
      detected: false,
    },
  ];

  const byId = Object.fromEntries(clients.map(client => [client.id, client]));
  byId.codex.detected =
    existsSync(byId.codex.configPath) ||
    Boolean(executableOnPath("codex", env, platform)) ||
    appExists(locations.apps.codex);
  byId["claude-code"].detected =
    existsSync(byId["claude-code"].configPath) ||
    Boolean(executableOnPath("claude", env, platform));
  byId["claude-desktop"].detected =
    existsSync(byId["claude-desktop"].configPath) ||
    appExists(locations.apps.claudeDesktop);
  byId.cursor.detected =
    existsSync(byId.cursor.configPath) ||
    Boolean(executableOnPath("cursor", env, platform)) ||
    appExists(locations.apps.cursor);
  byId.vscode.detected =
    existsSync(byId.vscode.configPath) ||
    Boolean(executableOnPath("code", env, platform)) ||
    appExists(locations.apps.vscode);
  byId.windsurf.detected =
    existsSync(byId.windsurf.configPath) ||
    Boolean(executableOnPath("windsurf", env, platform)) ||
    appExists(locations.apps.windsurf);

  return clients;
}

export function createServerConfig({
  nodePath = process.execPath,
  serverPath = path.join(REPO_ROOT, "server", "index.js"),
  includeType = false,
} = {}) {
  const config = {
    command: path.resolve(nodePath),
    args: [path.resolve(serverPath)],
  };
  if (includeType) return { type: "stdio", ...config };
  return config;
}

function parseJsonConfig(text, configPath) {
  const errors = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length) {
    const first = errors[0];
    throw new Error(
      `Cannot parse ${configPath}: ${printParseErrorCode(first.error)} at offset ${first.offset}.`,
    );
  }
  if (!isPlainObject(value)) {
    throw new Error(`Cannot update ${configPath}: the root value must be an object.`);
  }
  return value;
}

function writeConfigFile(configPath, nextText, { dryRun = false, log = console.log } = {}) {
  if (dryRun) {
    log(`  DRY RUN: would update ${configPath}`);
    return { changed: true, backupPath: null, dryRun: true };
  }

  mkdirSync(path.dirname(configPath), { recursive: true });
  let backupPath = null;
  const configExists = existsSync(configPath);
  if (configExists) {
    backupPath = `${configPath}.backup-${timestamp()}`;
    let suffix = 1;
    while (existsSync(backupPath)) {
      backupPath = `${configPath}.backup-${timestamp()}-${suffix++}`;
    }
    copyFileSync(configPath, backupPath);
  }

  if (configExists && lstatSync(configPath).isSymbolicLink()) {
    writeFileSync(configPath, nextText, "utf8");
    log(`  Updated: ${configPath}`);
    log(`  Backup:  ${backupPath}`);
    return { changed: true, backupPath, dryRun: false };
  }

  const tempPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const mode = configExists ? statSync(configPath).mode : 0o600;
  writeFileSync(tempPath, nextText, { encoding: "utf8", mode });
  try {
    renameSync(tempPath, configPath);
  } catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    writeFileSync(configPath, nextText, "utf8");
    unlinkSync(tempPath);
  }

  log(`  Updated: ${configPath}`);
  if (backupPath) log(`  Backup:  ${backupPath}`);
  return { changed: true, backupPath, dryRun: false };
}

export async function configureJsonClient(client, {
  nodePath = process.execPath,
  serverPath = path.join(REPO_ROOT, "server", "index.js"),
  dryRun = false,
  confirmReplace = async () => true,
  log = console.log,
} = {}) {
  const exists = existsSync(client.configPath);
  const rawText = exists ? readFileSync(client.configPath, "utf8") : "";
  const text = rawText.trim() ? rawText : "{}\n";
  const data = parseJsonConfig(text, client.configPath);
  const desired = createServerConfig({
    nodePath,
    serverPath,
    includeType: Boolean(client.includeType),
  });
  if (data[client.rootKey] !== undefined && !isPlainObject(data[client.rootKey])) {
    throw new Error(
      `Cannot update ${client.configPath}: "${client.rootKey}" must be an object.`,
    );
  }
  const container = data[client.rootKey] || {};
  const current = container[SERVER_NAME];

  if (sameJson(current, desired)) {
    log(`  Already configured: ${client.configPath}`);
    return { status: "unchanged", changed: false };
  }

  if (current !== undefined && !(await confirmReplace(client, current, desired))) {
    log(`  Skipped: ${client.label}`);
    return { status: "skipped", changed: false };
  }

  const eol = detectEol(text);
  const edits = modify(text, [client.rootKey, SERVER_NAME], desired, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
      eol,
    },
  });
  const nextText = applyEdits(text, edits);
  const writeResult = writeConfigFile(client.configPath, nextText, { dryRun, log });
  return { status: dryRun ? "dry-run" : "configured", ...writeResult };
}

function findTomlSection(text) {
  const headerPattern = /^\[mcp_servers\.figma-ui-mcp\]\s*$/m;
  const match = headerPattern.exec(text);
  if (!match) return null;

  const start = match.index;
  const headerEnd = start + match[0].length;
  const firstNewline = text.indexOf("\n", headerEnd);
  const contentStart = firstNewline === -1 ? text.length : firstNewline + 1;
  const nextHeaderPattern = /^\s*\[/gm;
  nextHeaderPattern.lastIndex = contentStart;
  const nextHeader = nextHeaderPattern.exec(text);

  return {
    start,
    end: nextHeader ? nextHeader.index : text.length,
  };
}

export async function configureCodexClient(client, {
  nodePath = process.execPath,
  serverPath = path.join(REPO_ROOT, "server", "index.js"),
  dryRun = false,
  confirmReplace = async () => true,
  log = console.log,
} = {}) {
  const exists = existsSync(client.configPath);
  const text = exists ? readFileSync(client.configPath, "utf8") : "";
  const eol = detectEol(text);
  const desiredSection = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(path.resolve(nodePath))}`,
    `args = [${tomlString(path.resolve(serverPath))}]`,
    "",
  ].join(eol);
  const section = findTomlSection(text);

  if (section && text.slice(section.start, section.end).trim() === desiredSection.trim()) {
    log(`  Already configured: ${client.configPath}`);
    return { status: "unchanged", changed: false };
  }

  if (section && !(await confirmReplace(client, text.slice(section.start, section.end), desiredSection))) {
    log(`  Skipped: ${client.label}`);
    return { status: "skipped", changed: false };
  }

  let nextText;
  if (section) {
    nextText = text.slice(0, section.start) + desiredSection + text.slice(section.end);
  } else {
    const prefix = text.length && !text.endsWith("\n") ? eol : "";
    const spacer = text.length ? eol : "";
    nextText = text + prefix + spacer + desiredSection;
  }

  const writeResult = writeConfigFile(client.configPath, nextText, { dryRun, log });
  return { status: dryRun ? "dry-run" : "configured", ...writeResult };
}

export async function configureClient(client, options = {}) {
  if (client.kind === "toml") return configureCodexClient(client, options);
  return configureJsonClient(client, options);
}

function parseArgs(argv) {
  const result = {
    clientValues: [],
    yes: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--yes" || arg === "-y") result.yes = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--client" || arg === "-c") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a comma-separated value.`);
      result.clientValues.push(value);
    } else if (arg.startsWith("--client=")) {
      result.clientValues.push(arg.slice("--client=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return result;
}

function expandClientIds(values, clients) {
  const known = new Set(clients.map(client => client.id));
  const aliases = {
    claude: ["claude-code", "claude-desktop"],
    "visual-studio-code": ["vscode"],
    visual: ["vscode"],
    "vs-code": ["vscode"],
    devin: ["windsurf"],
  };
  const requested = values
    .flatMap(value => value.split(","))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  if (requested.includes("all")) return clients.map(client => client.id);

  const expanded = [];
  for (const id of requested) {
    const ids = aliases[id] || [id];
    for (const resolved of ids) {
      if (!known.has(resolved)) throw new Error(`Unknown client: ${id}`);
      if (!expanded.includes(resolved)) expanded.push(resolved);
    }
  }
  return expanded;
}

function printHelp() {
  console.log(`
Figma UI MCP setup wizard

Usage:
  npm run setup
  npm run setup -- --client codex,cursor
  npm run setup -- --client all --yes
  npm run setup -- --client vscode --dry-run

Clients:
  codex, claude-code, claude-desktop, cursor, vscode, windsurf

Options:
  -c, --client <ids>  Configure one or more comma-separated clients
  -y, --yes           Replace an existing figma-ui-mcp entry without prompting
      --dry-run       Show planned changes without writing files
  -h, --help          Show this help
`.trim());
}

async function selectClients(clients, rl) {
  const detected = clients.filter(client => client.detected);
  const defaultIds = detected.map(client => client.id);

  console.log("\nDetected MCP clients:");
  clients.forEach((client, index) => {
    console.log(
      `  ${index + 1}. ${client.label}${client.detected ? " (detected)" : ""}\n` +
      `     ${client.configPath}`,
    );
  });

  const defaultText = defaultIds.length ? defaultIds.join(",") : "codex";
  const answer = await rl.question(
    `\nClients to configure [${defaultText}]: `,
  );
  return expandClientIds([answer.trim() || defaultText], clients);
}

export async function runSetup({
  argv = process.argv.slice(2),
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { exitCode: 0, results: [] };
  }

  const serverPath = path.join(REPO_ROOT, "server", "index.js");
  if (!existsSync(serverPath)) {
    throw new Error(`MCP server entry point not found: ${serverPath}`);
  }
  const nodePath = executableOnPath("node", env, platform) || process.execPath;

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) throw new Error("Node.js 18 or newer is required.");

  const clients = resolveClients({ home, platform, env });
  let selectedIds = expandClientIds(options.clientValues, clients);
  let rl = null;

  if (!selectedIds.length) {
    if (!stdin.isTTY) {
      throw new Error("No client selected. Use --client <id> in a non-interactive terminal.");
    }
    rl = readline.createInterface({ input: stdin, output: stdout });
    selectedIds = await selectClients(clients, rl);
  }

  const selected = selectedIds.map(id => clients.find(client => client.id === id));
  console.log("\nFigma UI MCP setup");
  console.log(`  Node:     ${nodePath}`);
  console.log(`  Server:   ${serverPath}`);
  console.log(`  Manifest: ${path.join(REPO_ROOT, "plugin", "manifest.json")}`);

  const confirmReplace = async client => {
    if (options.yes) return true;
    if (!rl) rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(
      `\n${client.label} already has a "${SERVER_NAME}" entry. Replace it? [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  };

  const results = [];
  for (const client of selected) {
    console.log(`\n${client.label}`);
    try {
      const result = await configureClient(client, {
        nodePath,
        serverPath,
        dryRun: options.dryRun,
        confirmReplace,
      });
      results.push({ client: client.id, ...result });
    } catch (error) {
      console.error(`  ERROR: ${error.message}`);
      results.push({ client: client.id, status: "error", error });
    }
  }

  if (rl) rl.close();

  const failures = results.filter(result => result.status === "error");
  const changed = results.filter(result => result.status === "configured").length;
  const unchanged = results.filter(result => result.status === "unchanged").length;
  const skipped = results.filter(result => result.status === "skipped").length;
  const previews = results.filter(result => result.status === "dry-run").length;

  console.log("\nSummary");
  console.log(`  Configured: ${changed}`);
  console.log(`  Unchanged:  ${unchanged}`);
  console.log(`  Skipped:    ${skipped}`);
  if (previews) console.log(`  Dry run:    ${previews}`);
  if (failures.length) console.log(`  Errors:     ${failures.length}`);

  if (!options.dryRun && !failures.length) {
    console.log("\nNext steps");
    console.log("  1. Fully quit and reopen the configured MCP client.");
    console.log("  2. In Figma Desktop, import plugin/manifest.json once.");
    console.log("  3. Run Figma UI MCP Bridge · Kiettt8. No Terminal command is needed.");
  }

  return { exitCode: failures.length ? 1 : 0, results };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runSetup()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch(error => {
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = 1;
    });
}
