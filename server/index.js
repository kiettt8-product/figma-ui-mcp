#!/usr/bin/env node
// figma-ui-mcp — MCP server entry point
// Bidirectional Figma bridge: write UI from Claude, read design back to code.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SERVICE_ID,
  BridgeServer,
  CONFIG,
} from "./bridge-server.js";
import { executeCode } from "./code-executor.js";
import { TOOLS } from "./tool-definitions.js";
import { getDocs } from "./api-docs.js";
import { createDesignSystemManager, DesignSystemGate } from "./design-system.js";

const designSystem = createDesignSystemManager();
const designSystemGate = new DesignSystemGate();
const initialDesignSystemStatus = designSystem.getStatus();
if (initialDesignSystemStatus.configured) {
  process.stderr.write(
    `[figma-ui-mcp] Design system ${initialDesignSystemStatus.name || initialDesignSystemStatus.id} ` +
    `${initialDesignSystemStatus.version || ""} loaded from ${initialDesignSystemStatus.bundlePath}\n`,
  );
} else {
  process.stderr.write(
    "[figma-ui-mcp] No design-system bundle configured; generic Figma mode enabled\n",
  );
}

// ── Bridge connection strategy ─────────────────────────────────────────────
// Try to start own bridge server. If port is already taken (another instance
// or standalone bridge running), connect to the existing one via HTTP client.

let bridge;
let useHttpProxy = false;

// HTTP proxy: forwards operations to existing bridge via /exec endpoint
const httpProxy = {
  port: CONFIG.PORT,
  isPluginConnected() { return true; }, // delegate health check to actual call
  get queueLength()  { return 0; },
  get lastPollAt()   { return Date.now(); },
  async sendOperation(operation, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ operation, params });
      const sessionQuery = sessionId
        ? `?sessionId=${encodeURIComponent(sessionId)}`
        : "";
      const req = http.request({
        hostname: "127.0.0.1", port: CONFIG.PORT,
        path: `/exec${sessionQuery}`, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, res => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.success) resolve(parsed.data);
            else reject(new Error(parsed.error || "Bridge error"));
          } catch { reject(new Error("Invalid bridge response")); }
        });
      });
      req.on("error", e => reject(new Error(`Bridge connection failed: ${e.message}`)));
      req.setTimeout(CONFIG.OP_TIMEOUT_MS, () => { req.destroy(); reject(new Error("Bridge timeout")); });
      req.end(payload);
    });
  },
  // Health check via HTTP
  async checkHealth() {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: "127.0.0.1", port: CONFIG.PORT,
        path: "/health", method: "GET",
      }, res => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            const compatible =
              parsed.serviceId === BRIDGE_SERVICE_ID &&
              parsed.protocolVersion === BRIDGE_PROTOCOL_VERSION;
            resolve({
              ...parsed,
              reachable: compatible,
              incompatibleService: !compatible,
            });
          }
          catch { resolve({ reachable: false, pluginConnected: false }); }
        });
      });
      req.on("error", () => resolve({ reachable: false, pluginConnected: false }));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve({ reachable: false, pluginConnected: false });
      });
      req.end();
    });
  },
};

// Check for an existing healthy bridge BEFORE starting our own.
// If one already exists and has the plugin connected, use HTTP proxy immediately.
// This prevents fallback sessions from starting unnecessary local bridges that
// #killStaleBridges() in later sessions might misclassify and kill.
const existingHealth = await httpProxy.checkHealth();
if (existingHealth.reachable) {
  useHttpProxy = true;
  bridge = httpProxy;
  process.stderr.write("[figma-ui-mcp] Existing background bridge detected, using HTTP proxy\n");
} else {
  // No healthy primary bridge — try to start our own
  try {
    bridge = await new BridgeServer().start();
    process.stderr.write("[figma-ui-mcp] Bridge started on port " + bridge.port + "\n");
  } catch (e) {
    useHttpProxy = true;
    bridge = httpProxy;
    process.stderr.write("[figma-ui-mcp] Bridge failed, connecting to existing bridge on port " + CONFIG.PORT + "\n");
  }

  // BridgeServer.start() never throws on EADDRINUSE (retries next port).
  // If it ended up on a fallback port but primary port has a live bridge, switch to proxy.
  if (!useHttpProxy && bridge.port !== CONFIG.PORT) {
    const primaryHealth = await httpProxy.checkHealth();
    if (primaryHealth.reachable) {
      // A figma-ui-mcp bridge already owns the primary port — we are a redundant session.
      // Stop our local bridge and use HTTP proxy to avoid being killed as "stale".
      bridge.stop();
      useHttpProxy = true;
      bridge = httpProxy;
      process.stderr.write("[figma-ui-mcp] Primary bridge exists on port " + CONFIG.PORT + ", switching to HTTP proxy\n");
    }
  }
}

const server = new Server(
  { name: "figma-ui-mcp", version: "2.5.27" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) => {

  // ── figma_status ──────────────────────────────────────────────────────────
  if (name === "figma_status") {
    let connected, pluginInfo = null, healthData = {};

    if (useHttpProxy) {
      healthData = await httpProxy.checkHealth();
      connected = healthData.pluginConnected;
      if (connected) {
        try { pluginInfo = await bridge.sendOperation("status", {}); } catch { /* brief disconnect */ }
      }
    } else {
      connected = bridge.isPluginConnected();
      if (connected) {
        try { pluginInfo = await bridge.sendOperation("status", {}); } catch { /* brief disconnect */ }
      }
    }

    const designSystemStatus = designSystem.getStatus();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          bridgePort:      bridge.port || CONFIG.PORT,
          pluginConnected: connected,
          pluginInfo,
          mode:            useHttpProxy ? "http-proxy" : "direct",
          queueLength:     healthData.queueLength || bridge.queueLength,
          lastPollAgoMs:   healthData.lastPollAgoMs || (bridge.lastPollAt ? Date.now() - bridge.lastPollAt : null),
          stats:           healthData.stats || (bridge.stats ? bridge.stats : null),
          sessions:        bridge.getSessions ? bridge.getSessions() : [],
          designSystem:    designSystemStatus,
          hint: connected
            ? designSystemStatus.configured
              ? "CONNECTED. Call figma_docs, then design_system_context for the target recipe. After writing, call figma_validate and fix every error."
              : "CONNECTED. BEFORE drawing anything: call figma_docs to load mandatory design rules (token system, component-first, icon sizing, layer order)."
            : "Plugin not connected. In Figma Desktop: Plugins → Development → Figma UI MCP Bridge → Run",
        }, null, 2),
      }],
    };
  }

  // ── figma_write ───────────────────────────────────────────────────────────
  if (name === "figma_write") {
    if (useHttpProxy) {
      const health = await httpProxy.checkHealth();
      if (!health.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();

    const code = args?.code;
    const writeSessionId = args?.sessionId;
    if (!code || typeof code !== "string") return err("'code' is required.");

    const designSystemStatus = designSystem.getStatus();
    if (designSystemStatus.configured && !designSystemStatus.ready) {
      return err(
        "Design-system preflight failed. Install the required fonts and restart Figma before writing. " +
        JSON.stringify(designSystemStatus.fontPreflight),
      );
    }
    if (
      designSystemStatus.configured &&
      !designSystemGate.canWrite(writeSessionId)
    ) {
      return err(
        "Design-system gate: call design_system_plan with the user's design request before " +
        "figma_write. This resolves the correct recipe, product patterns, states, assets, " +
        "prototype flow, and validation checklist automatically.",
      );
    }

    const { success, result, error, logs } = await executeCode(
      code,
      bridge,
      writeSessionId,
      {
        loadBundleAsset: (reference, options) => designSystem.readAsset(reference, options),
      },
    );
    const parts = [];
    if (logs.length) parts.push(`Logs:\n${logs.join("\n")}`);
    parts.push(success ? `Result: ${JSON.stringify(result, null, 2)}` : `Error: ${error}`);

    return { isError: !success, content: [{ type: "text", text: parts.join("\n\n") }] };
  }

  // ── figma_read ────────────────────────────────────────────────────────────
  if (name === "figma_read") {
    if (useHttpProxy) {
      const health = await httpProxy.checkHealth();
      if (!health.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();

    const { operation, nodeId, nodeName, scale, depth, format, detail, includeHidden, sessionId: readSessionId, ...searchParams } = args || {};
    if (!operation) return err("'operation' is required.");

    const params = {};
    if (nodeId)   params.id    = nodeId;
    if (nodeName) params.name  = nodeName;
    if (scale)    params.scale = scale;
    if (depth !== undefined) params.depth = depth;
    if (format) params.format = format;
    if (detail) params.detail = detail;
    if (includeHidden !== undefined) params.includeHidden = includeHidden;
    if (operation === "search_nodes") Object.assign(params, searchParams);

    try {
      const data = await bridge.sendOperation(operation, params, readSessionId);

      // Return screenshot as MCP image content (displays inline in Claude Code)
      if (operation === "screenshot" && data && data.dataUrl) {
        var b64 = data.dataUrl;
        if (b64.indexOf(",") !== -1) b64 = b64.split(",")[1];
        var meta = Object.assign({}, data);
        delete meta.dataUrl;
        var content = [{ type: "image", data: b64, mimeType: "image/png" }];
        if (Object.keys(meta).length > 0) {
          content.push({ type: "text", text: JSON.stringify(meta, null, 2) });
        }
        return { content: content };
      }

      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return err(e.message);
    }
  }

  // ── figma_docs ────────────────────────────────────────────────────────────
  if (name === "figma_docs") {
    let text = getDocs(args?.section);
    if (!args?.section && designSystem.getStatus().configured) {
      text += `\n\n${designSystem.buildContext()}`;
    }
    return { content: [{ type: "text", text }] };
  }

  // ── figma_rules ───────────────────────────────────────────────────────────
  // Aggregate design system rules from styles + variables + components into a
  // prompt-injectable markdown block. Equivalent to official MCP's create_design_system_rules.
  if (name === "figma_rules") {
    if (useHttpProxy) {
      const health = await httpProxy.checkHealth();
      if (!health.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();

    const sessionId = args?.sessionId;
    try {
      const [stylesData, varsData, compsData] = await Promise.all([
        bridge.sendOperation("get_styles", {}, sessionId),
        bridge.sendOperation("get_variables", {}, sessionId),
        bridge.sendOperation("get_local_components", {}, sessionId),
      ]);

      const lines = ["# Design System Rules", ""];
      lines.push("Use these tokens, styles, and components when writing code for this Figma file.", "");

      // Colors
      if (stylesData.paintStyles && stylesData.paintStyles.length) {
        lines.push("## Color Tokens (Paint Styles)");
        lines.push("```");
        stylesData.paintStyles.forEach(s => {
          if (s.hex) lines.push(`--${s.name.replace(/\//g, "-")}: ${s.hex};  /* ${s.name} */`);
        });
        lines.push("```", "");
      }

      // Variables by collection
      if (varsData.collections && varsData.collections.length) {
        varsData.collections.forEach(col => {
          if (!col.variables || !col.variables.length) return;
          lines.push(`## Variables — ${col.name}`);
          const modes = col.modes.map(m => m.name);
          if (modes.length > 1) lines.push(`Modes: ${modes.join(" | ")}`);
          lines.push("```");
          col.variables.forEach(v => {
            const vals = Object.values(v.valuesByMode || {});
            const preview = vals.length > 0 ? String(vals[0]) : "";
            lines.push(`${v.name} (${v.resolvedType})${preview ? ": " + preview : ""}`);
          });
          lines.push("```", "");
        });
      }

      // Typography
      if (stylesData.textStyles && stylesData.textStyles.length) {
        lines.push("## Typography Styles");
        lines.push("```");
        stylesData.textStyles.forEach(s => {
          lines.push(`${s.name}: ${s.fontFamily} ${s.fontWeight} ${s.fontSize}px${s.lineHeight ? " / " + s.lineHeight + "px" : ""}`);
        });
        lines.push("```", "");
      }

      // Components
      if (compsData.componentSets && compsData.componentSets.length) {
        lines.push("## Component Sets (use with get_component_map)");
        compsData.componentSets.forEach(s => {
          const desc = s.description ? ` — ${s.description}` : "";
          lines.push(`- **${s.name}** (${s.variantCount} variants)${desc}`);
        });
        lines.push("");
      }
      if (compsData.components && compsData.components.length) {
        lines.push("## Standalone Components");
        compsData.components.slice(0, 40).forEach(c => {
          const desc = c.description ? ` — ${c.description}` : "";
          lines.push(`- **${c.name}** (${c.width}×${c.height})${desc}`);
        });
        if (compsData.components.length > 40) lines.push(`  …and ${compsData.components.length - 40} more`);
        lines.push("");
      }

      lines.push("---");
      lines.push("_Generated by figma-ui-mcp figma_rules. Re-run when design system changes._");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return err("figma_rules failed: " + e.message);
    }
  }

  // ── design_system_status ─────────────────────────────────────────────────
  if (name === "design_system_status") {
    if (args?.reload) designSystem.reload();
    return {
      content: [{
        type: "text",
        text: JSON.stringify(designSystem.getStatus(), null, 2),
      }],
    };
  }

  // ── design_system_context ────────────────────────────────────────────────
  if (name === "design_system_context") {
    if (args?.reload) designSystem.reload();
    const status = designSystem.getStatus();
    if (!status.configured) {
      return err(
        "No design-system bundle is configured. Set FIGMA_UI_MCP_DESIGN_SYSTEM_BUNDLE " +
        "to an extracted bundle directory and restart the MCP server.",
      );
    }
    if (args?.recipe && !status.recipes.includes(args.recipe)) {
      return err(
        `Recipe not found: ${args.recipe}. Available recipes: ${status.recipes.join(", ") || "none"}`,
      );
    }
    designSystemGate.markContextLoaded(args?.sessionId);
    return {
      content: [{
        type: "text",
        text: designSystem.buildContext(args?.recipe),
      }],
    };
  }

  // ── design_system_plan ──────────────────────────────────────────────────
  if (name === "design_system_plan") {
    if (args?.reload) designSystem.reload();
    const status = designSystem.getStatus();
    if (!status.configured) {
      return err(
        "No design-system bundle is configured. Set FIGMA_UI_MCP_DESIGN_SYSTEM_BUNDLE " +
        "to an extracted bundle directory and restart the MCP server.",
      );
    }
    try {
      const plan = designSystem.createPlan(args?.prompt, {
        recipe: args?.recipe,
        maxAssets: args?.maxAssets,
      });
      designSystemGate.markPlanned(args?.sessionId);
      const contexts = Object.fromEntries(plan.recipes.map(recipe => [
        recipe.id,
        designSystem.buildContext(recipe.id),
      ]));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ...plan, contexts }, null, 2),
        }],
      };
    } catch (error) {
      return err(`design_system_plan failed: ${error.message}`);
    }
  }

  // ── design_system_assets ────────────────────────────────────────────────
  if (name === "design_system_assets") {
    if (args?.reload) designSystem.reload();
    const status = designSystem.getStatus();
    if (!status.configured) {
      return err("No design-system bundle is configured.");
    }
    const assets = designSystem.searchAssets(args?.query || "", {
      limit: args?.limit,
      source: args?.source,
      category: args?.category,
    });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          query: args?.query || "",
          count: assets.length,
          assets,
          import:
            "Use figma.loadBundleAsset(asset.id, opts) inside figma_write. " +
            "The runtime verifies path containment and SHA-256 before import.",
        }, null, 2),
      }],
    };
  }

  // ── figma_validate ───────────────────────────────────────────────────────
  if (name === "figma_validate") {
    if (useHttpProxy) {
      const health = await httpProxy.checkHealth();
      if (!health.pluginConnected) return notConnected();
    } else if (!bridge.isPluginConnected()) return notConnected();

    const status = designSystem.getStatus();
    if (!status.configured) {
      return err(
        "No design-system bundle is configured. Set FIGMA_UI_MCP_DESIGN_SYSTEM_BUNDLE first.",
      );
    }
    if (!args?.nodeId && !args?.nodeName) {
      return err("'nodeId' or 'nodeName' is required.");
    }
    try {
      const params = {
        depth: "full",
        detail: "compact",
        includeHidden: false,
      };
      if (args.nodeId) params.id = args.nodeId;
      if (args.nodeName) params.name = args.nodeName;
      const data = await bridge.sendOperation(
        "get_design",
        params,
        args?.sessionId,
      );
      if (!data?.tree) return err("Figma did not return a design tree for validation.");
      const report = designSystem.validate(data.tree, args?.recipe);
      return {
        isError: !report.ok,
        content: [{
          type: "text",
          text: JSON.stringify(report, null, 2),
        }],
      };
    } catch (error) {
      return err(`figma_validate failed: ${error.message}`);
    }
  }

  return err(`Unknown tool: ${name}`);
});

function notConnected() {
  return {
    isError: true,
    content: [{
      type: "text",
      text: "Figma plugin not connected. Run the 'Figma UI MCP Bridge' plugin in Figma Desktop first.",
    }],
  };
}

function err(msg) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

await server.connect(new StdioServerTransport());
