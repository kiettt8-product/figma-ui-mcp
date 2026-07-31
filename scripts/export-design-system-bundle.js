#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
let bridgeSessionId = "";

function parseArgs(argv) {
  const options = {
    port: 38451,
    version: "3.0.0",
    output: null,
    concurrency: 8,
    imageConcurrency: 2,
    sourceFileKey: "",
    expectedFile: "",
    sessionId: "",
    includeSvg: true,
    includeImages: true,
    skipMissingSvg: false,
    zip: true,
    packOnly: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      return value;
    };

    if (arg === "--port") options.port = Number(next());
    else if (arg === "--version") options.version = next();
    else if (arg === "--output") options.output = path.resolve(next());
    else if (arg === "--concurrency") options.concurrency = Number(next());
    else if (arg === "--image-concurrency") options.imageConcurrency = Number(next());
    else if (arg === "--source-file-key") options.sourceFileKey = next();
    else if (arg === "--expect-file") options.expectedFile = next();
    else if (arg === "--session") options.sessionId = next();
    else if (arg === "--no-svg") options.includeSvg = false;
    else if (arg === "--no-images") options.includeImages = false;
    else if (arg === "--skip-missing-svg") options.skipMissingSvg = true;
    else if (arg === "--no-zip") options.zip = false;
    else if (arg === "--pack-only") options.packOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be a valid TCP port.");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 24) {
    throw new Error("--concurrency must be between 1 and 24.");
  }
  if (
    !Number.isInteger(options.imageConcurrency) ||
    options.imageConcurrency < 1 ||
    options.imageConcurrency > 8
  ) {
    throw new Error("--image-concurrency must be between 1 and 8.");
  }

  if (!options.output) {
    options.output = path.resolve(
      REPO_ROOT,
      "..",
      "artifacts",
      `zalopay-design-system-${options.version}`,
    );
  }
  return options;
}

function printHelp() {
  console.log(`
Export the connected Figma file as a portable design-system bundle.

Usage:
  npm run bundle:export -- [options]

Options:
  --version <value>            Bundle version. Default: 3.0.0
  --output <directory>         Output directory
  --port <number>              Local bridge port. Default: 38451
  --source-file-key <key>      Source Figma file key for provenance
  --expect-file <name>         Stop if a different Figma file is connected
  --session <id>               Target one Figma tab when multiple tabs are connected
  --concurrency <number>       Concurrent SVG exports. Default: 8
  --image-concurrency <number> Concurrent PNG exports. Default: 2
  --no-svg                     Skip component SVG files
  --no-images                  Skip page image exports
  --skip-missing-svg           Keep previous diagnostics for missing SVG files
  --no-zip                     Keep only the bundle directory
  --pack-only                  Refresh checksums and ZIP without reading Figma
`.trim());
}

function ensureDir(directory) {
  mkdirSync(directory, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function slug(value, fallback = "item") {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function idFileName(id, extension) {
  return `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.${extension}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bridgeRequest(port, operation, params = {}, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ operation, params });
    const sessionQuery = bridgeSessionId
      ? `?sessionId=${encodeURIComponent(bridgeSessionId)}`
      : "";
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/exec${sessionQuery}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      response => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => {
          body += chunk;
        });
        response.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            reject(new Error(`${operation}: bridge returned invalid JSON (${response.statusCode}).`));
            return;
          }
          if (response.statusCode >= 400 || parsed.success === false) {
            reject(new Error(`${operation}: ${parsed.error || `HTTP ${response.statusCode}`}`));
            return;
          }
          resolve(parsed.data);
        });
      },
    );

    request.on("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`${operation}: timed out after ${timeoutMs}ms.`));
    });
    request.end(payload);
  });
}

async function requestWithRetry(port, operation, params, {
  attempts = 3,
  timeoutMs = 120_000,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await bridgeRequest(port, operation, params, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(350 * attempt);
    }
  }
  throw lastError;
}

async function mapLimit(items, concurrency, worker, onProgress) {
  let cursor = 0;
  let completed = 0;
  const results = new Array(items.length);

  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      completed++;
      if (onProgress) onProgress(completed, items.length, items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => run(),
  );
  await Promise.all(workers);
  return results;
}

function resolveVariableAliases(collections) {
  const variables = new Map();
  const modes = new Map();
  for (const collection of collections) {
    for (const mode of collection.modes || []) {
      modes.set(mode.id, { collection: collection.name, name: mode.name });
    }
    for (const variable of collection.variables || []) {
      variables.set(variable.id, { collection: collection.name, variable });
    }
  }

  function resolveValue(value, modeId, seen = new Set()) {
    if (!value || typeof value !== "object" || value.type !== "VARIABLE_ALIAS") {
      return { value };
    }
    if (seen.has(value.id)) return { aliasId: value.id, circular: true };
    const target = variables.get(value.id);
    if (!target) return { aliasId: value.id, missing: true };

    const nextSeen = new Set(seen);
    nextSeen.add(value.id);
    const targetValues = target.variable.values || {};
    let targetModeId = modeId;
    if (!(targetModeId in targetValues)) {
      targetModeId = Object.keys(targetValues)[0];
    }
    const resolved = resolveValue(targetValues[targetModeId], targetModeId, nextSeen);
    return {
      aliasId: value.id,
      alias: `${target.collection}/${target.variable.name}`,
      ...resolved,
    };
  }

  return collections.map(collection => ({
    id: collection.id,
    name: collection.name,
    modes: collection.modes || [],
    variables: (collection.variables || []).map(variable => ({
      id: variable.id,
      name: variable.name,
      type: variable.resolvedType,
      description: variable.description || "",
      values: Object.fromEntries(
        Object.entries(variable.values || {}).map(([modeId, value]) => [
          (modes.get(modeId) || {}).name || modeId,
          resolveValue(value, modeId),
        ]),
      ),
    })),
  }));
}

function classifyComponent(component) {
  const page = String(component.page || "").trim().toLowerCase();
  if (page.includes("icon logo")) return "brand-assets";
  if (page.includes("icons app")) return "app-icons";
  if (page.includes("icons")) return "icons";
  if (page === "archived") return "archived";
  return "components";
}

function isAssetCatalogPage(pageName) {
  const name = String(pageName || "").trim().toLowerCase();
  return (
    name.includes("icons (") ||
    name.includes("icon logo") ||
    name.includes("icons app") ||
    name === "archived"
  );
}

function walkFiles(directory, prefix = "") {
  const rows = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const relative = path.posix.join(prefix, name);
    const stats = statSync(absolute);
    if (stats.isDirectory()) rows.push(...walkFiles(absolute, relative));
    else rows.push({ absolute, relative, size: stats.size });
  }
  return rows;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function buildChecksums(outputDirectory) {
  const excluded = new Set([
    ".export-progress.json",
    "checksums.json",
    "manifest.json",
  ]);
  const files = walkFiles(outputDirectory).filter(row => !excluded.has(row.relative));
  const checksums = [];
  for (const file of files) {
    checksums.push({
      path: file.relative,
      size: file.size,
      sha256: await sha256File(file.absolute),
    });
  }
  return checksums;
}

function createZip(outputDirectory) {
  const parent = path.dirname(outputDirectory);
  const base = path.basename(outputDirectory);
  const archivePath = path.join(parent, `${base}.zip`);

  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${base}' -DestinationPath '${base}.zip' -Force`,
      ],
      { cwd: parent, stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error("PowerShell Compress-Archive failed.");
    return archivePath;
  }

  const result = spawnSync("zip", ["-q", "-r", "-FS", `${base}.zip`, base], {
    cwd: parent,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("zip command failed. Re-run with --no-zip to keep the directory only.");
  }
  return archivePath;
}

function optionalKnowledgeEntrypoints(outputDirectory) {
  const candidates = {
    productCatalog: "product/catalog.json",
    semanticAssets: "assets/semantic-catalog.json",
    assetAliases: "assets/aliases.json",
    goldenReferences: "references/catalog.json",
    productPatterns: "patterns/catalog.json",
    intentRouting: "routing/intents.json",
    validationProfiles: "validation/profiles.json",
    prototypeFlows: "flows/catalog.json",
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, relativePath]) =>
    existsSync(path.join(outputDirectory, ...relativePath.split("/"))),
  ));
}

async function packExistingBundle(options) {
  const manifestPath = path.join(options.output, "manifest.json");
  const manifest = readJson(manifestPath);
  if (!manifest) {
    throw new Error(`Bundle manifest not found: ${manifestPath}`);
  }

  manifest.packagedAt = new Date().toISOString();
  manifest.entrypoints = {
    ...(manifest.entrypoints || {}),
    ...optionalKnowledgeEntrypoints(options.output),
  };
  writeJson(manifestPath, manifest);
  const checksums = await buildChecksums(options.output);
  writeJson(path.join(options.output, "checksums.json"), {
    algorithm: "sha256",
    files: checksums,
  });

  const archivePath = options.zip ? createZip(options.output) : null;
  console.log("Bundle packaging complete");
  console.log(`  Directory: ${options.output}`);
  if (archivePath) console.log(`  Archive:   ${archivePath}`);
  console.log(`  Checksums: ${checksums.length}`);
}

function bundleReadme({ fileName, version, counts }) {
  return `# ZaloPay Design System Bundle

Version: ${version}
Source: ${fileName}

This artifact is generated for internal MCP use. It contains:

- Design tokens with resolved aliases and original Figma IDs.
- Text, effect, grid, and paint styles.
- Component and component-set catalogs.
- SVG exports for local component masters.
- Full text inventories and design scans for every Figma page.
- Raster exports for nodes with image fills.
- SHA-256 checksums for integrity verification.

Counts:

- Pages: ${counts.pages}
- Variables: ${counts.variables}
- Components: ${counts.components}
- Component sets: ${counts.componentSets}
- SVG assets: ${counts.svgAssets}
- Raster assets: ${counts.imageAssets}
- Warnings: ${counts.warnings}
- Errors: ${counts.errors}

Do not publish this bundle to a public repository or public package registry.
`;
}

function buildGeneratedSemanticCatalog(styles, resolvedVariables, componentCatalog) {
  const spacing = {};
  for (const collection of resolvedVariables.collections || []) {
    for (const variable of collection.variables || []) {
      if (!String(variable.name || "").startsWith("spacing/")) continue;
      const firstValue = Object.values(variable.values || {})[0];
      const value = firstValue && typeof firstValue === "object"
        ? firstValue.value
        : firstValue;
      if (typeof value === "number") spacing[variable.name] = value;
    }
  }

  const textStyles = styles.textStyles || [];
  const fontFamilies = [...new Set(textStyles.map(style => style.fontFamily).filter(Boolean))];
  return {
    schemaVersion: 1,
    generated: true,
    fonts: {
      primary: fontFamilies[0] || null,
      allowedFamilies: fontFamilies,
    },
    spacing,
    typography: Object.fromEntries(textStyles.map(style => [
      style.name,
      {
        style: style.name,
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      },
    ])),
    components: componentCatalog.map(component => ({
      name: component.name,
      page: component.page,
      width: component.width,
      height: component.height,
      category: component.category,
      assetPath: component.assetPath,
    })),
    policies: [
      "Run font preflight before generating a screen.",
      "Use semantic typography roles instead of arbitrary font properties.",
      "Use spacing tokens instead of arbitrary gaps and padding.",
      "Instantiate an existing component variant before drawing a replacement.",
      "Use Auto Layout for reusable components and repeated content.",
      "Run figma_validate after generation and fix all errors before handoff.",
    ],
  };
}

function buildGeneratedFontManifest(styles) {
  const families = new Map();
  for (const style of styles.textStyles || []) {
    if (!style.fontFamily) continue;
    if (!families.has(style.fontFamily)) families.set(style.fontFamily, new Set());
    if (style.fontWeight) families.get(style.fontFamily).add(style.fontWeight);
  }
  return {
    schemaVersion: 1,
    generated: true,
    bundled: false,
    required: [...families.entries()].map(([family, weights]) => ({
      family,
      weights: [...weights].sort(),
      distribution: "Font binaries are not included in the portable design-system bundle.",
      installHint: `Install ${family} with the required weights, then fully restart Figma Desktop.`,
    })),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  bridgeSessionId = options.sessionId;
  if (options.packOnly) {
    await packExistingBundle(options);
    return;
  }

  ensureDir(options.output);
  const progressPath = path.join(options.output, ".export-progress.json");
  const progress = readJson(progressPath, {
    startedAt: new Date().toISOString(),
    stages: {},
  });
  const errors = [];
  const warnings = [];
  const previousErrors = readJson(path.join(options.output, "errors.json"), []);
  const previousWarnings = readJson(path.join(options.output, "warnings.json"), []);

  console.log("Checking Figma bridge...");
  const status = await requestWithRetry(options.port, "status", {});
  if (options.expectedFile && status.fileName !== options.expectedFile) {
    throw new Error(
      `Connected file is "${status.fileName}", expected "${options.expectedFile}".`,
    );
  }
  console.log(`  File: ${status.fileName}`);
  console.log(`  Page: ${status.currentPage}`);
  console.log(`  Output: ${options.output}`);

  const [pages, variables, styles, localComponents] = await Promise.all([
    requestWithRetry(options.port, "listPages", {}),
    requestWithRetry(options.port, "get_variables", {}),
    requestWithRetry(options.port, "get_styles", {}),
    requestWithRetry(options.port, "get_local_components", {}, { timeoutMs: 180_000 }),
  ]);

  const collections = variables.collections || [];
  const components = localComponents.components || [];
  const componentSets = localComponents.componentSets || [];
  const variableCount = collections.reduce(
    (total, collection) => total + (collection.variables || []).length,
    0,
  );

  writeJson(path.join(options.output, "source", "file.json"), {
    fileName: status.fileName,
    fileKey: options.sourceFileKey || null,
    exportedAt: new Date().toISOString(),
    pluginVersion: status.version || null,
    pageCount: pages.length,
  });
  writeJson(path.join(options.output, "source", "pages.json"), pages);
  writeJson(path.join(options.output, "tokens", "variables.raw.json"), variables);
  const resolvedVariables = { collections: resolveVariableAliases(collections) };
  writeJson(
    path.join(options.output, "tokens", "variables.resolved.json"),
    resolvedVariables,
  );
  writeJson(path.join(options.output, "styles", "styles.json"), styles);
  writeJson(path.join(options.output, "components", "components.json"), components);
  writeJson(path.join(options.output, "components", "component-sets.json"), componentSets);

  const pageComponentCounts = {};
  for (const component of components) {
    const page = component.page || "Unknown";
    pageComponentCounts[page] = (pageComponentCounts[page] || 0) + 1;
  }
  writeJson(path.join(options.output, "components", "by-page.json"), pageComponentCounts);

  progress.stages.metadata = {
    completedAt: new Date().toISOString(),
    pages: pages.length,
    variables: variableCount,
    components: components.length,
    componentSets: componentSets.length,
  };
  writeJson(progressPath, progress);

  console.log(`Exporting documentation from ${pages.length} pages...`);
  const pageCatalog = [];
  const allImageNodes = [];

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const pageDirectory = path.join(
      options.output,
      "documentation",
      `${String(index + 1).padStart(2, "0")}-${slug(page.name, "page")}-${idFileName(page.id, "data").replace(".data", "")}`,
    );
    ensureDir(pageDirectory);
    console.log(`  [${index + 1}/${pages.length}] ${page.name}`);

    const scanPath = path.join(pageDirectory, "scan.json");
    const textsPath = path.join(pageDirectory, "texts.json");
    const imageNodesPath = path.join(pageDirectory, "image-nodes.json");
    const entry = {
      id: page.id,
      name: page.name,
      directory: path.relative(options.output, pageDirectory).split(path.sep).join("/"),
      errors: [],
    };

    if (isAssetCatalogPage(page.name)) {
      entry.deepScanSkipped = true;
      entry.reason =
        "Asset catalog page; every local component is preserved in the component catalog and SVG export.";
      entry.componentCount = pageComponentCounts[page.name] || 0;
      writeJson(path.join(pageDirectory, "asset-page.json"), entry);
      pageCatalog.push(entry);
      writeJson(path.join(options.output, "documentation", "pages.json"), pageCatalog);
      progress.stages.documentation = {
        completedPages: index + 1,
        totalPages: pages.length,
        updatedAt: new Date().toISOString(),
      };
      writeJson(progressPath, progress);
      continue;
    }

    const cachedScan = readJson(scanPath);
    const cachedTexts = readJson(textsPath);
    const cachedImageNodes = readJson(imageNodesPath);
    if (cachedScan && !cachedScan.partial && cachedTexts && cachedImageNodes) {
      entry.totalNodes = cachedScan.totalNodes;
      entry.textNodes = cachedTexts.total || 0;
      entry.imageNodes = cachedImageNodes.total || 0;
      entry.resumedFromCache = true;
      if (cachedScan.partial) {
        entry.scanPartial = true;
        entry.warnings = [cachedScan.reason || "Page scan is partial."];
        warnings.push({
          stage: "page-scan",
          pageId: page.id,
          pageName: page.name,
          warning: cachedScan.reason || "Page scan is partial.",
        });
      }
      for (const node of cachedImageNodes.results || []) {
        allImageNodes.push({ ...node, pageId: page.id, pageName: page.name });
      }
      pageCatalog.push(entry);
      writeJson(path.join(options.output, "documentation", "pages.json"), pageCatalog);
      progress.stages.documentation = {
        completedPages: index + 1,
        totalPages: pages.length,
        updatedAt: new Date().toISOString(),
      };
      writeJson(progressPath, progress);
      continue;
    }

    try {
      const scan = await requestWithRetry(
        options.port,
        "scan_design",
        { id: page.id, includeHidden: true },
        { timeoutMs: 180_000 },
      );
      writeJson(scanPath, scan);
      entry.totalNodes = scan.totalNodes;
    } catch (error) {
      entry.scanPartial = true;
      entry.warnings = [error.message];
      writeJson(scanPath, {
        rootId: page.id,
        rootName: page.name,
        rootType: "PAGE",
        partial: true,
        reason: error.message,
        note: "Full text and image inventories are stored beside this file.",
      });
      warnings.push({
        stage: "page-scan",
        pageId: page.id,
        pageName: page.name,
        warning: error.message,
      });
    }

    try {
      const texts = await requestWithRetry(
        options.port,
        "search_nodes",
        { id: page.id, type: "TEXT", includeHidden: true, limit: 100_000 },
        { timeoutMs: 180_000 },
      );
      writeJson(textsPath, texts);
      entry.textNodes = texts.total || 0;
    } catch (error) {
      entry.errors.push(error.message);
      errors.push({ stage: "page-text", pageId: page.id, pageName: page.name, error: error.message });
    }

    try {
      const imageNodes = await requestWithRetry(
        options.port,
        "search_nodes",
        { id: page.id, hasImage: true, includeHidden: true, limit: 100_000 },
        { timeoutMs: 180_000 },
      );
      writeJson(imageNodesPath, imageNodes);
      entry.imageNodes = imageNodes.total || 0;
      for (const node of imageNodes.results || []) {
        allImageNodes.push({ ...node, pageId: page.id, pageName: page.name });
      }
    } catch (error) {
      entry.errors.push(error.message);
      errors.push({ stage: "page-images", pageId: page.id, pageName: page.name, error: error.message });
    }

    pageCatalog.push(entry);
    writeJson(path.join(options.output, "documentation", "pages.json"), pageCatalog);
    progress.stages.documentation = {
      completedPages: index + 1,
      totalPages: pages.length,
      updatedAt: new Date().toISOString(),
    };
    writeJson(progressPath, progress);
  }

  progress.stages.documentation.completedAt = new Date().toISOString();
  writeJson(progressPath, progress);

  const componentCatalog = components.map(component => {
    const category = classifyComponent(component);
    const pageDirectory = slug(component.page || "unknown", "unknown");
    const assetPath = path.posix.join(
      "assets",
      "svg",
      category,
      pageDirectory,
      idFileName(component.id, "svg"),
    );
    return { ...component, category, assetPath };
  });
  writeJson(
    path.join(options.output, "components", "catalog.json"),
    componentCatalog,
  );
  writeJson(
    path.join(options.output, "semantic", "catalog.generated.json"),
    buildGeneratedSemanticCatalog(styles, resolvedVariables, componentCatalog),
  );
  writeJson(
    path.join(options.output, "fonts", "manifest.generated.json"),
    buildGeneratedFontManifest(styles),
  );

  let svgExported = 0;
  let svgSkipped = 0;
  if (options.includeSvg) {
    console.log(`Exporting ${componentCatalog.length} component SVG files...`);
    await mapLimit(
      componentCatalog,
      options.concurrency,
      async component => {
        const filePath = path.join(options.output, ...component.assetPath.split("/"));
        if (existsSync(filePath) && statSync(filePath).size > 20) {
          svgSkipped++;
          component.assetStatus = "exported";
          return;
        }
        if (options.skipMissingSvg) {
          const previous = [...previousErrors, ...previousWarnings].find(
            row => row.stage === "component-svg" && row.nodeId === component.id,
          );
          const previousMessage = previous
            ? previous.error || previous.warning
            : "SVG asset is missing after export.";
          const message = previousMessage.includes("timed out")
            ? "SVG export did not complete after a dedicated retry of up to 180 seconds."
            : previousMessage;
          const knownNonRenderingTrayState =
            component.page === "Tray" &&
            ["state=Left", "state=Right", "state=Bottom", "state=Top"].includes(component.name);
          if (message.includes("may not have any visible layers") || knownNonRenderingTrayState) {
            component.assetStatus = "non-rendering";
            warnings.push({
              stage: "component-svg",
              nodeId: component.id,
              name: component.name,
              page: component.page,
              warning: knownNonRenderingTrayState
                ? "Component has no visible layers and is preserved as metadata only."
                : message,
            });
          } else {
            component.assetStatus = "error";
            errors.push({
              stage: "component-svg",
              nodeId: component.id,
              name: component.name,
              page: component.page,
              error: message,
            });
          }
          return;
        }
        try {
          const result = await requestWithRetry(
            options.port,
            "export_svg",
            { id: component.id },
            { attempts: 1, timeoutMs: 210_000 },
          );
          if (!result.svg || !result.svg.includes("<svg")) {
            throw new Error("Export did not return valid SVG.");
          }
          ensureDir(path.dirname(filePath));
          writeFileSync(filePath, result.svg, "utf8");
          svgExported++;
          component.assetStatus = "exported";
        } catch (error) {
          if (error.message.includes("may not have any visible layers")) {
            component.assetStatus = "non-rendering";
            warnings.push({
              stage: "component-svg",
              nodeId: component.id,
              name: component.name,
              page: component.page,
              warning: error.message,
            });
          } else {
            component.assetStatus = "error";
            errors.push({
              stage: "component-svg",
              nodeId: component.id,
              name: component.name,
              page: component.page,
              error: error.message,
            });
          }
        }
      },
      (completed, total) => {
        if (completed === total || completed % 50 === 0) {
          console.log(`  SVG ${completed}/${total}`);
          progress.stages.svg = {
            completed,
            total,
            exportedThisRun: svgExported,
            skippedExisting: svgSkipped,
            updatedAt: new Date().toISOString(),
          };
          writeJson(progressPath, progress);
        }
      },
    );
    progress.stages.svg.completedAt = new Date().toISOString();
    writeJson(progressPath, progress);
    writeJson(
      path.join(options.output, "components", "catalog.json"),
      componentCatalog,
    );
  }

  const uniqueImageNodes = [
    ...new Map(allImageNodes.map(node => [node.id, node])).values(),
  ];
  const imageCatalog = uniqueImageNodes.map(node => {
    const assetPath = path.posix.join(
      "assets",
      "images",
      slug(node.pageName, "page"),
      idFileName(node.id, "png"),
    );
    return { ...node, assetPath };
  });
  writeJson(path.join(options.output, "assets", "images", "catalog.json"), imageCatalog);

  let imagesExported = 0;
  let imagesSkipped = 0;
  if (options.includeImages) {
    console.log(`Exporting ${imageCatalog.length} page image nodes...`);
    await mapLimit(
      imageCatalog,
      options.imageConcurrency,
      async image => {
        const filePath = path.join(options.output, ...image.assetPath.split("/"));
        if (existsSync(filePath) && statSync(filePath).size > 20) {
          imagesSkipped++;
          return;
        }
        try {
          const result = await requestWithRetry(
            options.port,
            "export_image",
            { id: image.id, format: "PNG", scale: 1 },
            { timeoutMs: 180_000 },
          );
          const bytes = Buffer.from(result.base64 || "", "base64");
          if (!bytes.length) throw new Error("Export returned an empty image.");
          ensureDir(path.dirname(filePath));
          writeFileSync(filePath, bytes);
          imagesExported++;
        } catch (error) {
          errors.push({
            stage: "page-image",
            nodeId: image.id,
            name: image.name,
            page: image.pageName,
            error: error.message,
          });
        }
      },
      (completed, total) => {
        if (completed === total || completed % 10 === 0) {
          console.log(`  Images ${completed}/${total}`);
          progress.stages.images = {
            completed,
            total,
            exportedThisRun: imagesExported,
            skippedExisting: imagesSkipped,
            updatedAt: new Date().toISOString(),
          };
          writeJson(progressPath, progress);
        }
      },
    );
    progress.stages.images.completedAt = new Date().toISOString();
    writeJson(progressPath, progress);
  }

  const counts = {
    pages: pages.length,
    variables: variableCount,
    components: components.length,
    componentSets: componentSets.length,
    svgAssets: componentCatalog.filter(component =>
      existsSync(path.join(options.output, ...component.assetPath.split("/"))),
    ).length,
    imageAssets: imageCatalog.filter(image =>
      existsSync(path.join(options.output, ...image.assetPath.split("/"))),
    ).length,
    textStyles: (styles.textStyles || []).length,
    effectStyles: (styles.effectStyles || []).length,
    gridStyles: (styles.gridStyles || []).length,
    warnings: warnings.length,
    errors: errors.length,
  };

  writeJson(path.join(options.output, "errors.json"), errors);
  writeJson(path.join(options.output, "warnings.json"), warnings);
  writeFileSync(
    path.join(options.output, "README.md"),
    bundleReadme({ fileName: status.fileName, version: options.version, counts }),
    "utf8",
  );

  const checksums = await buildChecksums(options.output);
  writeJson(path.join(options.output, "checksums.json"), {
    algorithm: "sha256",
    files: checksums,
  });

  const manifest = {
    schemaVersion: 1,
    id: "zalopay-design-system",
    name: "ZaloPay Design System",
    version: options.version,
    source: {
      type: "figma",
      fileName: status.fileName,
      fileKey: options.sourceFileKey || null,
      pageCount: pages.length,
    },
    exportedAt: new Date().toISOString(),
    counts,
    entrypoints: {
      variables: "tokens/variables.resolved.json",
      rawVariables: "tokens/variables.raw.json",
      styles: "styles/styles.json",
      components: "components/catalog.json",
      componentSets: "components/component-sets.json",
      semanticCatalog: existsSync(path.join(options.output, "semantic", "catalog.json"))
        ? "semantic/catalog.json"
        : "semantic/catalog.generated.json",
      fontManifest: existsSync(path.join(options.output, "fonts", "manifest.json"))
        ? "fonts/manifest.json"
        : "fonts/manifest.generated.json",
      recipes: existsSync(path.join(options.output, "recipes"))
        ? "recipes"
        : null,
      documentation: "documentation/pages.json",
      imageCatalog: "assets/images/catalog.json",
      checksums: "checksums.json",
      errors: "errors.json",
      warnings: "warnings.json",
      ...optionalKnowledgeEntrypoints(options.output),
    },
  };
  writeJson(path.join(options.output, "manifest.json"), manifest);

  progress.completedAt = new Date().toISOString();
  progress.counts = counts;
  writeJson(progressPath, progress);

  let archivePath = null;
  if (options.zip) {
    console.log("Creating ZIP archive...");
    archivePath = createZip(options.output);
  }

  console.log("\nBundle export complete");
  console.log(`  Directory: ${options.output}`);
  if (archivePath) console.log(`  Archive:   ${archivePath}`);
  console.log(`  Components: ${counts.components}`);
  console.log(`  SVG assets: ${counts.svgAssets}`);
  console.log(`  Images:     ${counts.imageAssets}`);
  console.log(`  Errors:     ${counts.errors}`);
}

main().catch(error => {
  console.error(`Bundle export failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
