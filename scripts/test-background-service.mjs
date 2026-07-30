import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLinuxSystemdUnit,
  buildMacLaunchAgent,
  buildWindowsStartupScript,
  installBackgroundService,
  SERVICE_ID,
} from "./background-service.js";

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "figma-mcp-background-"));
const fakeHome = path.join(fixtureRoot, "User With Spaces");
const fakeNode = path.join(fixtureRoot, "Node Runtime", "node");
const fakeDaemon = path.join(fixtureRoot, "Figma MCP", "server", "bridge-daemon.js");
mkdirSync(path.dirname(fakeDaemon), { recursive: true });
writeFileSync(fakeDaemon, "// fixture\n", "utf8");

try {
  const macPlist = buildMacLaunchAgent({
    nodePath: fakeNode,
    daemonPath: fakeDaemon,
    repoRoot: path.dirname(path.dirname(fakeDaemon)),
    stdoutPath: path.join(fakeHome, "bridge.log"),
    stderrPath: path.join(fakeHome, "bridge.error.log"),
  });
  assert.match(macPlist, new RegExp(`<string>${SERVICE_ID}</string>`));
  assert.match(macPlist, /<key>RunAtLoad<\/key>/);
  assert.match(macPlist, /<key>KeepAlive<\/key>/);
  assert.match(macPlist, /<string>\/usr\/bin\/env<\/string>/);
  assert.match(macPlist, /<string>-i<\/string>/);
  assert.match(macPlist, /127\.0\.0\.1/);
  assert.match(macPlist, /Node Runtime/);

  const linuxUnit = buildLinuxSystemdUnit({
    nodePath: fakeNode,
    daemonPath: fakeDaemon,
    repoRoot: path.dirname(path.dirname(fakeDaemon)),
  });
  assert.match(linuxUnit, /^ExecStart=\/usr\/bin\/env -i .*Node Runtime.*bridge-daemon\.js"$/m);
  assert.match(linuxUnit, /^Restart=always$/m);

  const windowsScript = buildWindowsStartupScript({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    daemonPath: "C:\\Figma MCP\\bridge-daemon.js",
  });
  assert.equal(
    windowsScript,
    'Set shell = CreateObject("WScript.Shell")\r\n' +
      'shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Figma MCP\\bridge-daemon.js""", 0, False\r\n',
  );

  const dryRun = await installBackgroundService({
    platform: "darwin",
    home: fakeHome,
    nodePath: fakeNode,
    daemonPath: fakeDaemon,
    dryRun: true,
    log: () => {},
  });
  assert.equal(dryRun.status, "dry-run");
  assert.equal(
    existsSync(path.join(fakeHome, "Library", "LaunchAgents", `${SERVICE_ID}.plist`)),
    false,
  );

  const linuxDryRun = await installBackgroundService({
    platform: "linux",
    home: fakeHome,
    env: {},
    nodePath: fakeNode,
    daemonPath: fakeDaemon,
    dryRun: true,
    log: () => {},
  });
  assert.equal(
    linuxDryRun.filePath,
    path.join(fakeHome, ".config", "systemd", "user", "figma-ui-mcp-bridge.service"),
  );

  const windowsDryRun = await installBackgroundService({
    platform: "win32",
    home: fakeHome,
    env: {},
    nodePath: fakeNode,
    daemonPath: fakeDaemon,
    dryRun: true,
    log: () => {},
  });
  assert.equal(
    windowsDryRun.filePath,
    path.join(
      fakeHome,
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "Figma UI MCP Bridge.vbs",
    ),
  );

  console.log("background-service tests passed");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
