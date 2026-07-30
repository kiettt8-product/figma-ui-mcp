#!/usr/bin/env node

import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { BridgeServer, CONFIG } from "./bridge-server.js";

let bridge = null;
let stopping = false;
let attempts = 0;

async function startPrimaryBridge() {
  while (!stopping) {
    try {
      bridge = await new BridgeServer().start({ strictPort: true });
      process.stderr.write(
        `[figma-ui-mcp daemon] Bridge ready at http://${CONFIG.HOST}:${bridge.port}\n`,
      );
      return;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      attempts++;
      if (attempts === 1 || attempts % 15 === 0) {
        process.stderr.write(
          `[figma-ui-mcp daemon] Port ${CONFIG.PORT} is busy; waiting for it to become available\n`,
        );
      }
      await sleep(2_000);
    }
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  process.stderr.write(`[figma-ui-mcp daemon] Received ${signal}; stopping\n`);
  if (bridge) bridge.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

startPrimaryBridge().catch(error => {
  process.stderr.write(`[figma-ui-mcp daemon] Fatal: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
