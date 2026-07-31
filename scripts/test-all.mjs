#!/usr/bin/env node

import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const includeNetwork = process.env.FIGMA_UI_MCP_INCLUDE_NETWORK_TESTS === "1";
const excluded = new Set([
  "test-all.mjs",
  ...(includeNetwork ? [] : ["test-icon-network.mjs"]),
]);
const testFiles = readdirSync(scriptsDirectory)
  .filter(name => name.startsWith("test-") && name.endsWith(".mjs"))
  .filter(name => !excluded.has(name))
  .sort();

for (const name of testFiles) {
  process.stdout.write(`\n[test] ${name}\n`);
  const result = spawnSync(process.execPath, [path.join(scriptsDirectory, name)], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.stderr.write(`\nTest failed: ${name}\n`);
    process.exit(result.status || 1);
  }
}

if (!includeNetwork) {
  process.stdout.write(
    "\nNetwork-dependent icon-library test skipped. Run npm run test:network to include it.\n",
  );
}
process.stdout.write(`\nAll ${testFiles.length} offline test files passed.\n`);
