import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BundleAssetResolver, resolveBundlePath } from "./asset-resolver.js";
import { buildProductPlan } from "./product-knowledge.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SERVER_DIR, "..");
const FONT_REGISTRY_TTL_MS = 60_000;
let fontRegistryCache = null;
let fontRegistryCachedAt = 0;

function readJson(filePath, fallback = null) {
  if (!filePath || !existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function resolveEntrypoint(bundlePath, entrypoint, fallback) {
  const relativePath = entrypoint || fallback;
  return relativePath ? resolveBundlePath(bundlePath, relativePath) : null;
}

function listJsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => name.endsWith(".json") && name !== "index.json")
    .sort()
    .map(name => path.join(directory, name));
}

function findBundlePath(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(explicitPath));
  if (process.env.FIGMA_UI_MCP_DESIGN_SYSTEM_BUNDLE) {
    candidates.push(path.resolve(process.env.FIGMA_UI_MCP_DESIGN_SYSTEM_BUNDLE));
  }
  candidates.push(path.join(REPO_ROOT, "design-system-bundle"));
  candidates.push(path.join(homedir(), ".figma-ui-mcp", "design-system", "current"));

  const artifactsDirectory = path.resolve(REPO_ROOT, "..", "artifacts");
  if (existsSync(artifactsDirectory)) {
    const artifacts = readdirSync(artifactsDirectory)
      .map(name => path.join(artifactsDirectory, name))
      .filter(directory => existsSync(path.join(directory, "manifest.json")))
      .sort((left, right) =>
        statSync(path.join(right, "manifest.json")).mtimeMs -
        statSync(path.join(left, "manifest.json")).mtimeMs,
      );
    candidates.push(...artifacts);
  }

  return candidates.find(directory => existsSync(path.join(directory, "manifest.json"))) || null;
}

function normalizeHex(value) {
  if (typeof value !== "string" || !value.startsWith("#")) return null;
  const hex = value.toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex) || /^#[0-9a-f]{8}$/.test(hex)) return hex;
  return null;
}

function collectResolvedVariables(variablesData) {
  const rows = [];
  for (const collection of variablesData?.collections || []) {
    for (const variable of collection.variables || []) {
      const values = variable.values || variable.valuesByMode || {};
      const resolved = [];
      for (const modeValue of Object.values(values)) {
        if (modeValue && typeof modeValue === "object" && "value" in modeValue) {
          resolved.push(modeValue.value);
        } else {
          resolved.push(modeValue);
        }
      }
      rows.push({
        collection: collection.name,
        name: variable.name,
        type: variable.type || variable.resolvedType,
        values: resolved,
      });
    }
  }
  return rows;
}

function buildFallbackSemantic(styles, variables, components) {
  const variableRows = collectResolvedVariables(variables);
  const spacing = {};
  for (const variable of variableRows) {
    if (variable.name?.startsWith("spacing/") && typeof variable.values[0] === "number") {
      spacing[variable.name] = variable.values[0];
    }
  }

  const fontFamilies = [
    ...new Set((styles?.textStyles || []).map(style => style.fontFamily).filter(Boolean)),
  ];
  return {
    schemaVersion: 1,
    generated: true,
    fonts: {
      primary: fontFamilies[0] || null,
      allowedFamilies: fontFamilies,
    },
    spacing,
    typography: Object.fromEntries(
      (styles?.textStyles || []).map(style => [
        style.name,
        {
          fontFamily: style.fontFamily,
          fontWeight: style.fontWeight,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        },
      ]),
    ),
    components: (components || []).map(component => ({
      name: component.name,
      width: component.width,
      height: component.height,
      page: component.page,
    })),
    policies: [
      "Use design-system typography roles instead of arbitrary font properties.",
      "Use spacing tokens instead of arbitrary gaps and padding.",
      "Instantiate an existing component variant before drawing a replacement.",
      "Run figma_validate after generation and fix all errors before handoff.",
    ],
  };
}

function getFontRegistry() {
  if (fontRegistryCache && Date.now() - fontRegistryCachedAt < FONT_REGISTRY_TTL_MS) {
    return fontRegistryCache;
  }
  const result = spawnSync(
    "fc-list",
    ["--format", "%{family}\t%{style}\t%{file}\n"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status === 0 && result.stdout) {
    fontRegistryCache = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const [family = "", style = "", file = ""] = line.split("\t");
        return { family, style, file };
      });
    fontRegistryCachedAt = Date.now();
    return fontRegistryCache;
  }

  const fontDirectories = process.platform === "darwin"
    ? [
      path.join(homedir(), "Library", "Fonts"),
      "/Library/Fonts",
      "/System/Library/Fonts",
    ]
    : process.platform === "win32"
      ? [
        process.env.WINDIR ? path.join(process.env.WINDIR, "Fonts") : null,
        process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts")
          : null,
      ].filter(Boolean)
      : [path.join(homedir(), ".local", "share", "fonts"), "/usr/share/fonts"];
  const rows = [];
  for (const directory of fontDirectories) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const base = name.replace(/\.(ttf|ttc|otf|woff2?)$/i, "");
      const styleMatch = base.match(
        /(?:^|[-_ ])(thin|extralight|ultralight|light|regular|normal|medium|semibold|demibold|bold|extrabold|black)(?:[-_ ]|$)/i,
      );
      const numericWeight = base.match(/(?:^|[-_ ])([1-9]00)(?:[-_ ]|$)/)?.[1];
      const numericStyle = {
        100: "Thin",
        200: "ExtraLight",
        300: "Light",
        400: "Regular",
        500: "Medium",
        600: "SemiBold",
        700: "Bold",
        800: "ExtraBold",
        900: "Black",
      }[numericWeight];
      const family = styleMatch
        ? base.slice(0, styleMatch.index).replace(/[-_]+$/g, "").trim()
        : base.replace(/[-_](?:italic|oblique)$/i, "").trim();
      rows.push({
        family: family.replaceAll("_", " "),
        style: numericStyle || styleMatch?.[1] || base,
        file: path.join(directory, name),
      });
    }
  }
  fontRegistryCache = rows;
  fontRegistryCachedAt = Date.now();
  return fontRegistryCache;
}

function fontPreflight(fontManifest, semantic) {
  const required = fontManifest?.required || [];
  if (!required.length && semantic?.fonts?.primary) {
    required.push({
      family: semantic.fonts.primary,
      aliases: semantic.fonts.aliases || [],
      weights: ["Regular", "Bold"],
    });
  }
  const registry = getFontRegistry();
  const checks = required.map(font => {
    const acceptedFamilies = [font.family, ...(font.aliases || [])]
      .filter(Boolean)
      .map(value => value.toLowerCase());
    const matches = registry.filter(row => {
      const family = row.family.toLowerCase();
      return acceptedFamilies.some(accepted =>
        family === accepted || family.split(",").map(value => value.trim()).includes(accepted),
      );
    });
    const missingWeights = (font.weights || []).filter(weight =>
      !matches.some(row => row.style.toLowerCase().includes(String(weight).toLowerCase())),
    );
    return {
      family: font.family,
      aliases: font.aliases || [],
      requiredWeights: font.weights || [],
      installed: matches.length > 0,
      missingWeights,
      files: [...new Set(matches.map(row => row.file).filter(Boolean))],
      installHint: font.installHint || null,
    };
  });
  return {
    ok: checks.every(check => check.installed && check.missingWeights.length === 0),
    checks,
  };
}

function globRegex(pattern) {
  const escaped = String(pattern || "*")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function flattenTree(root) {
  const rows = [];
  function visit(node, parent = null, absX = 0, absY = 0) {
    const absoluteX = absX + Number(node.x || 0);
    const absoluteY = absY + Number(node.y || 0);
    const row = { node, parent, absX: absoluteX, absY: absoluteY };
    rows.push(row);
    for (const child of node.children || []) {
      visit(child, row, absoluteX, absoluteY);
    }
  }
  visit(root);
  return rows;
}

function numeric(value) {
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function makeFinding(severity, code, message, row, expected, actual) {
  return {
    severity,
    code,
    message,
    nodeId: row?.node?.id || null,
    nodeName: row?.node?.name || null,
    expected,
    actual,
  };
}

function validateTypography(rows, semantic, findings) {
  const roles = Object.values(semantic?.typography || {});
  const allowedFamilies = [
    semantic?.fonts?.primary,
    ...(semantic?.fonts?.aliases || []),
    ...(semantic?.fonts?.allowedFamilies || []),
  ].filter(Boolean).map(value => value.toLowerCase());

  for (const row of rows.filter(entry => entry.node.type === "TEXT")) {
    const node = row.node;
    if (allowedFamilies.length && node.fontFamily) {
      const actual = node.fontFamily.toLowerCase();
      if (!allowedFamilies.includes(actual)) {
        findings.push(makeFinding(
          "error",
          "font-family",
          `Text uses ${node.fontFamily}; the configured design system requires ${semantic.fonts.primary}.`,
          row,
          semantic.fonts.primary,
          node.fontFamily,
        ));
      }
    }
    if (roles.length && node.fontSize) {
      const size = numeric(node.fontSize);
      const lineHeight = numeric(node.lineHeight);
      const matches = roles.some(role =>
        numeric(role.fontSize) === size &&
        (!role.lineHeight || lineHeight === null || numeric(role.lineHeight) === lineHeight),
      );
      if (!matches) {
        findings.push(makeFinding(
          "warning",
          "typography-role",
          `Typography ${size}px/${lineHeight ?? "auto"}px does not match a catalog role.`,
          row,
          "A semantic typography role",
          `${size}px/${lineHeight ?? "auto"}px`,
        ));
      }
    }
  }
}

function validateColors(rows, variables, findings) {
  const allowed = new Set();
  for (const variable of collectResolvedVariables(variables)) {
    for (const value of variable.values) {
      const hex = normalizeHex(value);
      if (hex) allowed.add(hex.slice(0, 7));
    }
  }
  if (!allowed.size) return;

  for (const row of rows) {
    const node = row.node;
    if (!["FRAME", "RECTANGLE", "ELLIPSE", "TEXT"].includes(node.type)) continue;
    const fill = normalizeHex(node.fill);
    if (fill && fill !== "#00000000" && !allowed.has(fill.slice(0, 7))) {
      findings.push(makeFinding(
        "warning",
        "unmapped-color",
        `Fill ${fill} is not present in the bundle variable catalog.`,
        row,
        "A design-system color variable",
        fill,
      ));
    }
  }
}

function validateAssetProvenance(rows, semantic, assetResolver, findings) {
  const policy = semantic?.assetPolicy || {};
  if (!policy.requireBundleProvenanceForIcons || !assetResolver) return;

  for (const row of rows.filter(entry => entry.node.isIcon)) {
    const hasIconAncestor = (() => {
      let cursor = row.parent;
      while (cursor) {
        if (cursor.node.isIcon || cursor.node.assetProvenance?.source === "bundle") return true;
        cursor = cursor.parent;
      }
      return false;
    })();
    if (hasIconAncestor) continue;

    const node = row.node;
    const provenance = node.assetProvenance || null;
    if (
      policy.allowFigmaComponentInstances !== false &&
      node.type === "INSTANCE" &&
      (node.componentId || node.componentName)
    ) {
      continue;
    }

    if (provenance?.source === "bundle") {
      const reference = provenance.assetId || provenance.reference;
      let resolved = null;
      try {
        resolved = assetResolver.resolveExact(reference);
      } catch {
        resolved = null;
      }
      if (!resolved) {
        findings.push(makeFinding(
          "error",
          "bundle-asset-unresolved",
          `${node.name} claims bundle provenance but its asset cannot be resolved.`,
          row,
          "A valid bundle asset ID",
          reference || null,
        ));
      }
      continue;
    }

    if (provenance?.source === "external-icon-library") {
      let bundledMatch = null;
      try {
        bundledMatch = assetResolver.resolveExact(
          provenance.reference,
          { categories: ["icon", "icons", "utility-icon"] },
        );
      } catch {
        bundledMatch = null;
      }
      if (bundledMatch) {
        findings.push(makeFinding(
          "error",
          "external-icon-when-bundled",
          `${node.name} uses ${provenance.library || "an external icon library"} even though the bundle provides ${bundledMatch.name}.`,
          row,
          bundledMatch.id,
          provenance.reference || node.name,
        ));
      } else {
        findings.push(makeFinding(
          policy.externalFallbackSeverity || "warning",
          "external-icon-fallback",
          `${node.name} uses a reviewed external fallback because no exact bundle alias was found.`,
          row,
          "A semantic bundle icon alias",
          provenance.reference || node.name,
        ));
      }
      continue;
    }

    findings.push(makeFinding(
      policy.missingProvenanceSeverity || "error",
      "asset-provenance-missing",
      `${node.name} looks like an icon but has no design-system asset provenance.`,
      row,
      "Bundle asset metadata or a Figma component instance",
      null,
    ));
  }
}

function descendantsOf(containerRow, rows) {
  return rows.filter(row => {
    let cursor = row.parent;
    while (cursor) {
      if (cursor === containerRow) return true;
      cursor = cursor.parent;
    }
    return false;
  });
}

function findByPattern(rows, pattern, type) {
  const regex = globRegex(pattern);
  return rows.filter(row =>
    regex.test(row.node.name || "") && (!type || row.node.type === type),
  );
}

function validateRecipe(tree, rows, recipe, findings) {
  if (!recipe) return;
  const tolerance = recipe.tolerance ?? 1;
  if (recipe.viewport) {
    for (const dimension of ["width", "height"]) {
      if (recipe.viewport[dimension] === undefined) continue;
      if (Math.abs(Number(tree[dimension]) - Number(recipe.viewport[dimension])) > tolerance) {
        findings.push(makeFinding(
          "error",
          `viewport-${dimension}`,
          `Root ${dimension} does not match the recipe viewport.`,
          rows[0],
          recipe.viewport[dimension],
          tree[dimension],
        ));
      }
    }
  }

  for (const required of recipe.required || []) {
    const matches = findByPattern(rows, required.namePattern || required.name, required.type);
    if (!matches.length) {
      findings.push(makeFinding(
        required.severity || "error",
        "required-node",
        `Missing required ${required.type || "node"}: ${required.namePattern || required.name}.`,
        rows[0],
        required.namePattern || required.name,
        null,
      ));
    }
  }

  for (const rule of recipe.nodeRules || []) {
    const pattern = rule.namePattern || rule.name;
    const matches = findByPattern(rows, pattern, rule.type);
    if (!matches.length && rule.required !== false) {
      findings.push(makeFinding(
        rule.severity || "error",
        "node-rule",
        `No node matches ${pattern || rule.type || "the configured node rule"}.`,
        rows[0],
        pattern || rule.type,
        null,
      ));
      continue;
    }
    for (const row of matches) {
      for (const field of ["width", "height", "x", "y"]) {
        if (rule[field] === undefined) continue;
        if (Math.abs(Number(row.node[field]) - Number(rule[field])) > (rule.tolerance ?? tolerance)) {
          findings.push(makeFinding(
            rule.severity || "error",
            `node-${field}`,
            `${row.node.name} has an invalid ${field}.`,
            row,
            rule[field],
            row.node[field],
          ));
        }
      }
      if (rule.typography) {
        for (const [field, expected] of Object.entries(rule.typography)) {
          const actual = row.node[field];
          if (String(actual) !== String(expected)) {
            findings.push(makeFinding(
              rule.severity || "error",
              `node-${field}`,
              `${row.node.name} does not use the required typography role.`,
              row,
              expected,
              actual,
            ));
          }
        }
      }
      if (rule.layoutMode) {
        const actualLayoutMode = row.node.layoutMode || row.node.layout?.mode || "NONE";
        if (actualLayoutMode !== rule.layoutMode) {
          findings.push(makeFinding(
            rule.severity || "error",
            "node-layout-mode",
            `${row.node.name} does not use the required Auto Layout direction.`,
            row,
            rule.layoutMode,
            actualLayoutMode,
          ));
        }
      }
    }
  }

  for (const group of recipe.repeatGroups || []) {
    const matches = findByPattern(rows, group.namePattern, group.type)
      .sort((left, right) => left.absY - right.absY);
    for (let index = 1; index < matches.length; index++) {
      const previous = matches[index - 1];
      const current = matches[index];
      const gap = current.absY - (previous.absY + Number(previous.node.height || 0));
      if (Math.abs(gap - group.gap) > (group.tolerance ?? tolerance)) {
        findings.push(makeFinding(
          group.severity || "error",
          "repeat-gap",
          `Repeated ${group.namePattern} items do not use the required vertical gap.`,
          current,
          group.gap,
          gap,
        ));
      }
    }
  }

  for (const containerRule of recipe.containerRules || []) {
    const containers = findByPattern(rows, containerRule.namePattern, containerRule.type);
    for (const container of containers) {
      const descendants = descendantsOf(container, rows);
      for (const relationship of containerRule.relationships || []) {
        const from = findByPattern(descendants, relationship.from)[0];
        const to = findByPattern(descendants, relationship.to)[0];
        if (!from || !to) {
          if (!relationship.optional) {
            findings.push(makeFinding(
              "error",
              "relationship-node",
              `Cannot validate ${relationship.from} → ${relationship.to} in ${container.node.name}.`,
              container,
              `${relationship.from} and ${relationship.to}`,
              "missing node",
            ));
          }
          continue;
        }
        let actual;
        if (relationship.measure === "centerY") {
          actual =
            (to.node.y + to.node.height / 2) -
            (from.node.y + from.node.height / 2);
        } else {
          actual = to.node.y - (from.node.y + from.node.height);
        }
        if (Math.abs(actual - relationship.value) > (relationship.tolerance ?? tolerance)) {
          findings.push(makeFinding(
            relationship.severity || "error",
            "vertical-rhythm",
            `${relationship.from} → ${relationship.to} has the wrong vertical rhythm.`,
            to,
            relationship.value,
            actual,
          ));
        }
      }
      for (const padding of containerRule.bottomPadding || []) {
        const target = findByPattern(descendants, padding.node)[0];
        if (!target) continue;
        const actual =
          Number(container.node.height) - (Number(target.node.y) + Number(target.node.height));
        if (Math.abs(actual - padding.value) > (padding.tolerance ?? tolerance)) {
          findings.push(makeFinding(
            padding.severity || "error",
            "bottom-padding",
            `${padding.node} has the wrong bottom padding in ${container.node.name}.`,
            target,
            padding.value,
            actual,
          ));
        }
      }
    }
  }

  for (const relation of recipe.globalRelationships || []) {
    const fromMatches = findByPattern(rows, relation.from);
    const toMatches = findByPattern(rows, relation.to);
    const from = relation.fromPick === "last"
      ? fromMatches.sort((left, right) => right.absY - left.absY)[0]
      : fromMatches[0];
    const to = toMatches[0];
    if (!from || !to) continue;
    const actual = to.absY - (from.absY + Number(from.node.height || 0));
    if (Math.abs(actual - relation.value) > (relation.tolerance ?? tolerance)) {
      findings.push(makeFinding(
        relation.severity || "error",
        "global-gap",
        `${relation.from} → ${relation.to} has the wrong vertical gap.`,
        to,
        relation.value,
        actual,
      ));
    }
  }
}

export class DesignSystemManager {
  constructor({ bundlePath } = {}) {
    this.bundlePath = findBundlePath(bundlePath);
    this.loaded = false;
    this.reload();
  }

  reload() {
    this.loaded = false;
    if (!this.bundlePath) return;
    this.manifest = readJson(path.join(this.bundlePath, "manifest.json"));
    if (!this.manifest) return;

    const entrypoints = this.manifest.entrypoints || {};
    this.styles = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.styles,
      "styles/styles.json",
    ), {});
    this.variables = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.variables,
      "tokens/variables.resolved.json",
    ), {});
    this.components = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.components,
      "components/catalog.json",
    ), []);
    this.imageCatalog = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.imageCatalog,
      "assets/images/catalog.json",
    ), []);
    this.semantic = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.semanticCatalog,
      "semantic/catalog.json",
    )) || readJson(path.join(this.bundlePath, "semantic", "catalog.generated.json")) ||
      buildFallbackSemantic(this.styles, this.variables, this.components);
    this.fontManifest = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.fontManifest,
      "fonts/manifest.json",
    )) || readJson(path.join(this.bundlePath, "fonts", "manifest.generated.json"), {});

    this.recipes = new Map();
    const recipesDirectory = resolveEntrypoint(
      this.bundlePath,
      entrypoints.recipes,
      "recipes",
    );
    for (const filePath of listJsonFiles(recipesDirectory)) {
      const recipe = readJson(filePath);
      if (recipe?.id) this.recipes.set(recipe.id, recipe);
    }

    const combinedProductCatalog = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.productCatalog,
      "product/catalog.json",
    ), {});
    const intentRouting = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.intentRouting,
      "routing/intents.json",
    ), {});
    const productPatterns = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.productPatterns,
      "patterns/catalog.json",
    ), {});
    const goldenReferences = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.goldenReferences,
      "references/catalog.json",
    ), {});
    const prototypeFlows = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.prototypeFlows,
      "flows/catalog.json",
    ), {});
    this.productCatalog = {
      schemaVersion: combinedProductCatalog.schemaVersion || 1,
      intents: combinedProductCatalog.intents || intentRouting.intents || [],
      patterns: combinedProductCatalog.patterns || productPatterns.patterns || [],
      references: combinedProductCatalog.references || goldenReferences.references || [],
      journeys: combinedProductCatalog.journeys || prototypeFlows.flows || [],
      validation: combinedProductCatalog.validation || {},
    };

    const semanticAssets = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.semanticAssets,
      "assets/semantic-catalog.json",
    ), {});
    const assetAliases = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.assetAliases,
      "assets/aliases.json",
    ), {});
    const checksums = readJson(resolveEntrypoint(
      this.bundlePath,
      entrypoints.checksums,
      "checksums.json",
    ), {});
    this.assetResolver = new BundleAssetResolver({
      bundlePath: this.bundlePath,
      components: this.components,
      images: this.imageCatalog,
      semanticAssets: semanticAssets.assets || [],
      aliases: assetAliases,
      checksums,
      requireChecksums: Boolean(entrypoints.checksums),
    });
    this.loaded = true;
  }

  getRecipe(recipeId) {
    return recipeId ? this.recipes.get(recipeId) || null : null;
  }

  getStatus() {
    if (!this.loaded) {
      return {
        configured: false,
        bundlePath: null,
        hint:
          "Set FIGMA_UI_MCP_DESIGN_SYSTEM_BUNDLE to an extracted bundle directory.",
      };
    }
    const fonts = fontPreflight(this.fontManifest, this.semantic);
    const exportErrors = Number(this.manifest.counts?.errors || 0);
    const exportWarnings = Number(this.manifest.counts?.warnings || 0);
    const hasProductKnowledge = Boolean(
      this.productCatalog?.intents?.length ||
      this.productCatalog?.patterns?.length ||
      this.productCatalog?.journeys?.length,
    );
    const generationReasons = [
      ...(exportErrors
        ? [`${exportErrors} exported assets are unavailable; affected patterns must use a reviewed fallback.`]
        : []),
      ...(this.recipes.size ? [] : ["No semantic recipes are installed."]),
      ...(hasProductKnowledge ? [] : ["No product intent or pattern catalog is installed."]),
    ];
    return {
      configured: true,
      bundlePath: this.bundlePath,
      id: this.manifest.id,
      name: this.manifest.name,
      version: this.manifest.version,
      exportedAt: this.manifest.exportedAt,
      recipes: [...this.recipes.keys()],
      productKnowledge: {
        intents: this.productCatalog?.intents?.length || 0,
        patterns: this.productCatalog?.patterns?.length || 0,
        journeys: this.productCatalog?.journeys?.length || 0,
        references: this.productCatalog?.references?.length || 0,
      },
      assets: this.assetResolver?.assets?.length || 0,
      semanticCatalog: Boolean(this.semantic),
      fontPreflight: fonts,
      ready: fonts.ok,
      readiness: {
        core: {
          ok: fonts.ok,
          reasons: fonts.ok ? [] : ["Required fonts are missing or incomplete."],
        },
        generation: {
          ok: fonts.ok && this.recipes.size > 0,
          state: generationReasons.length ? "degraded" : "ready",
          reasons: generationReasons,
        },
        intentRouting: {
          ok: hasProductKnowledge,
        },
      },
      warnings: [
        ...(fonts.ok ? [] : ["Required fonts are missing or incomplete."]),
        ...(this.recipes.size ? [] : ["No semantic recipes are installed."]),
        ...(hasProductKnowledge ? [] : ["No product intent or pattern catalog is installed."]),
        ...(exportErrors ? [`Bundle manifest reports ${exportErrors} export errors.`] : []),
        ...(exportWarnings ? [`Bundle manifest reports ${exportWarnings} export warnings.`] : []),
      ],
    };
  }

  buildContext(recipeId) {
    if (!this.loaded) {
      return "# Design System\n\nNo bundle is configured.";
    }
    const recipe = this.getRecipe(recipeId);
    const status = this.getStatus();
    const lines = [
      `# ${this.manifest.name || "Design System"} Runtime Context`,
      "",
      `Bundle version: ${this.manifest.version || "unknown"}`,
      `Font readiness: ${status.fontPreflight.ok ? "ready" : "missing dependency"}`,
      "",
      "## Mandatory policies",
    ];
    for (const policy of this.semantic.policies || []) lines.push(`- ${policy}`);

    lines.push("", "## Font");
    lines.push(`- Primary: ${this.semantic.fonts?.primary || "not specified"}`);
    if (this.semantic.fonts?.aliases?.length) {
      lines.push(`- Accepted aliases: ${this.semantic.fonts.aliases.join(", ")}`);
    }

    lines.push("", "## Spacing tokens");
    for (const [name, value] of Object.entries(this.semantic.spacing || {})) {
      lines.push(`- ${name}: ${value}px`);
    }

    lines.push("", "## Typography roles");
    for (const [name, role] of Object.entries(this.semantic.typography || {})) {
      lines.push(
        `- ${name}: ${role.fontFamily || this.semantic.fonts?.primary || ""} ` +
        `${role.fontWeight || ""} ${role.fontSize}px/${role.lineHeight}px`,
      );
    }

    if (this.semantic.componentRoles) {
      lines.push("", "## Component roles");
      for (const [name, role] of Object.entries(this.semantic.componentRoles)) {
        lines.push(`- ${name}: ${role.component || role.match || JSON.stringify(role)}`);
      }
    }

    if (this.semantic.assetPolicy?.requireBundleProvenanceForIcons) {
      lines.push("", "## Asset provenance");
      lines.push("- Use figma.loadBundleAsset() or bundle-first figma.loadIcon() for icons.");
      lines.push("- Do not redraw an icon with VECTOR, LINE, ELLIPSE, or placeholder geometry.");
      lines.push("- External icon libraries are fallback-only when no exact bundle alias exists.");
      lines.push("- figma_validate treats missing bundle provenance as an error.");
    }

    if (recipe) {
      lines.push("", `## Recipe: ${recipe.name || recipe.id}`);
      for (const rule of recipe.instructions || []) lines.push(`- ${rule}`);
      if (recipe.generator?.blueprint) {
        lines.push("", "### Auto Layout blueprint", "```json");
        lines.push(JSON.stringify(recipe.generator.blueprint, null, 2));
        lines.push("```");
      }
    }

    lines.push(
      "",
      "After generating the screen, call figma_validate with the root node and recipe ID.",
    );
    return lines.join("\n");
  }

  createPlan(prompt, { recipe = null, maxAssets = 12 } = {}) {
    if (!this.loaded) {
      throw new Error("No design-system bundle is configured.");
    }
    return buildProductPlan({
      prompt,
      catalog: this.productCatalog,
      recipes: [...this.recipes.values()],
      explicitRecipe: recipe,
      maxAssets,
      searchAssets: (query, options) => this.searchAssets(query, options),
    });
  }

  searchAssets(query, options = {}) {
    if (!this.loaded || !this.assetResolver) return [];
    return this.assetResolver.search(query, options);
  }

  readAsset(reference, options = {}) {
    if (!this.loaded || !this.assetResolver) {
      throw new Error("No design-system bundle is configured.");
    }
    const resolved = this.assetResolver.read(reference, options);
    return {
      ...resolved,
      asset: {
        ...resolved.asset,
        bundleId: this.manifest.id || null,
        bundleVersion: this.manifest.version || null,
      },
    };
  }

  readIcon(reference, options = {}) {
    if (!this.loaded || !this.assetResolver) return null;
    const asset = this.assetResolver.resolveExact(reference, {
      categories: ["icon", "icons", "utility-icon"],
    });
    if (!asset) return null;
    return this.readAsset(asset.id, options);
  }

  validate(tree, recipeId) {
    if (!this.loaded) {
      return {
        ok: false,
        error: "No design-system bundle is configured.",
        findings: [],
      };
    }
    const recipe = this.getRecipe(recipeId);
    if (recipeId && !recipe) {
      return {
        ok: false,
        error: `Recipe not found: ${recipeId}`,
        availableRecipes: [...this.recipes.keys()],
        findings: [],
      };
    }
    const rows = flattenTree(tree);
    const findings = [];
    validateTypography(rows, this.semantic, findings);
    validateColors(rows, this.variables, findings);
    validateAssetProvenance(rows, this.semantic, this.assetResolver, findings);
    validateRecipe(tree, rows, recipe, findings);
    const counts = findings.reduce(
      (result, finding) => {
        result[finding.severity] = (result[finding.severity] || 0) + 1;
        return result;
      },
      { error: 0, warning: 0, info: 0 },
    );
    return {
      ok: counts.error === 0,
      recipe: recipe?.id || null,
      root: {
        id: tree.id,
        name: tree.name,
        width: tree.width,
        height: tree.height,
      },
      counts,
      findings,
      nextAction: counts.error > 0
        ? {
          action: "repair-and-revalidate",
          message: "Fix every error, then call figma_validate again on the same root frame.",
        }
        : counts.warning > 0
          ? {
            action: "review-warnings-and-screenshot",
            message:
              "Review warnings that affect visual quality, inspect a 1x screenshot, then revalidate after changes.",
          }
          : {
            action: "inspect-screenshot-and-prototype",
            message:
              "Semantic validation passed. Inspect a 1x screenshot and verify prototype destinations before handoff.",
          },
    };
  }
}

export function createDesignSystemManager(options) {
  return new DesignSystemManager(options);
}

export class DesignSystemGate {
  constructor() {
    this.sessions = new Map();
  }

  key(sessionId) {
    return sessionId || "_default";
  }

  state(sessionId) {
    return this.sessions.get(this.key(sessionId)) || {
      planned: false,
      contextLoaded: false,
    };
  }

  markPlanned(sessionId) {
    this.sessions.set(this.key(sessionId), {
      ...this.state(sessionId),
      planned: true,
    });
  }

  markContextLoaded(sessionId) {
    this.sessions.set(this.key(sessionId), {
      ...this.state(sessionId),
      contextLoaded: true,
    });
  }

  canWrite(sessionId) {
    const state = this.state(sessionId);
    return state.planned || state.contextLoaded;
  }
}
