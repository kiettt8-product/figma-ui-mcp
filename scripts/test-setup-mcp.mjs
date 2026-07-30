import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureClient,
  createServerConfig,
  resolveClients,
  SERVER_NAME,
} from "./setup-mcp.js";

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "figma-mcp-setup-"));
const fakeHome = path.join(fixtureRoot, "User With Spaces");
const fakeCodexHome = path.join(fakeHome, ".codex-active");
const fakeNode = path.join(fixtureRoot, "Node Runtime", "node");
const fakeServer = path.join(fixtureRoot, "Figma MCP", "server", "index.js");

mkdirSync(fakeHome, { recursive: true });

const env = {
  PATH: "",
  CODEX_HOME: fakeCodexHome,
  XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
};
const clients = resolveClients({
  home: fakeHome,
  platform: "linux",
  env,
});
const byId = Object.fromEntries(clients.map(client => [client.id, client]));

try {
  // JSONC: preserve comments and unrelated servers while adding our entry.
  mkdirSync(path.dirname(byId.cursor.configPath), { recursive: true });
  writeFileSync(
    byId.cursor.configPath,
    `{
  // Keep this comment and server.
  "mcpServers": {
    "existing": {
      "command": "existing-tool"
    },
  },
}
`,
    "utf8",
  );

  const cursorFirst = await configureClient(byId.cursor, {
    nodePath: fakeNode,
    serverPath: fakeServer,
    confirmReplace: async () => true,
    log: () => {},
  });
  assert.equal(cursorFirst.status, "configured");

  const cursorText = readFileSync(byId.cursor.configPath, "utf8");
  assert.match(cursorText, /Keep this comment and server/);
  assert.match(cursorText, /"existing"/);
  assert.match(cursorText, new RegExp(`"${SERVER_NAME}"`));
  assert.match(cursorText, /Node Runtime/);
  assert.match(cursorText, /Figma MCP/);

  const cursorSecond = await configureClient(byId.cursor, {
    nodePath: fakeNode,
    serverPath: fakeServer,
    confirmReplace: async () => true,
    log: () => {},
  });
  assert.equal(cursorSecond.status, "unchanged");

  const cursorBackups = readdirSync(path.dirname(byId.cursor.configPath))
    .filter(name => name.startsWith("mcp.json.backup-"));
  assert.equal(cursorBackups.length, 1, "idempotent rerun must not create another backup");

  // Codex TOML: replace only the server section and preserve tool policy.
  mkdirSync(path.dirname(byId.codex.configPath), { recursive: true });
  writeFileSync(
    byId.codex.configPath,
    `[model]
name = "example"

[mcp_servers.${SERVER_NAME}]
command = "npx"
args = ["-y", "figma-ui-mcp"]

[mcp_servers.${SERVER_NAME}.tools.figma_read]
approval_mode = "approve"

[mcp_servers.other]
command = "other"
`,
    "utf8",
  );

  const codexFirst = await configureClient(byId.codex, {
    nodePath: fakeNode,
    serverPath: fakeServer,
    confirmReplace: async () => true,
    log: () => {},
  });
  assert.equal(codexFirst.status, "configured");

  const codexText = readFileSync(byId.codex.configPath, "utf8");
  assert.match(codexText, /Node Runtime/);
  assert.match(codexText, /approval_mode = "approve"/);
  assert.match(codexText, /\[mcp_servers\.other\]/);
  assert.doesNotMatch(codexText, /args = \["-y", "figma-ui-mcp"\]/);

  const codexSecond = await configureClient(byId.codex, {
    nodePath: fakeNode,
    serverPath: fakeServer,
    confirmReplace: async () => true,
    log: () => {},
  });
  assert.equal(codexSecond.status, "unchanged");

  // VS Code requires an explicit stdio type.
  const vscodeConfig = createServerConfig({
    nodePath: fakeNode,
    serverPath: fakeServer,
    includeType: true,
  });
  assert.deepEqual(vscodeConfig, {
    type: "stdio",
    command: path.resolve(fakeNode),
    args: [path.resolve(fakeServer)],
  });
  const vscodeFirst = await configureClient(byId.vscode, {
    nodePath: fakeNode,
    serverPath: fakeServer,
    confirmReplace: async () => true,
    log: () => {},
  });
  assert.equal(vscodeFirst.status, "configured");
  assert.equal(statSync(byId.vscode.configPath).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(readFileSync(byId.vscode.configPath, "utf8"))
      .servers[SERVER_NAME].type,
    "stdio",
  );

  // An existing empty JSON config is treated as an empty object.
  mkdirSync(path.dirname(byId["claude-desktop"].configPath), { recursive: true });
  writeFileSync(byId["claude-desktop"].configPath, "", "utf8");
  const claudeDesktopFirst = await configureClient(byId["claude-desktop"], {
    nodePath: fakeNode,
    serverPath: fakeServer,
    confirmReplace: async () => true,
    log: () => {},
  });
  assert.equal(claudeDesktopFirst.status, "configured");
  assert.equal(
    JSON.parse(readFileSync(byId["claude-desktop"].configPath, "utf8"))
      .mcpServers[SERVER_NAME].command,
    path.resolve(fakeNode),
  );

  // Dry run must not create a config file.
  assert.equal(existsSync(byId.windsurf.configPath), false);
  const windsurfDryRun = await configureClient(byId.windsurf, {
    nodePath: fakeNode,
    serverPath: fakeServer,
    dryRun: true,
    confirmReplace: async () => true,
    log: () => {},
  });
  assert.equal(windsurfDryRun.status, "dry-run");
  assert.equal(existsSync(byId.windsurf.configPath), false);

  console.log("setup-mcp tests passed");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
