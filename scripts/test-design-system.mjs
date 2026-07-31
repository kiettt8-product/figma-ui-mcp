import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeCode } from "../server/code-executor.js";
import { BundleAssetResolver, resolveBundlePath } from "../server/asset-resolver.js";
import {
  createDesignSystemManager,
  DesignSystemGate,
} from "../server/design-system.js";

const fixtureDirectory = mkdtempSync(path.join(os.tmpdir(), "figma-ui-mcp-design-system-"));

function writeJson(relativePath, value) {
  const filePath = path.join(fixtureDirectory, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(relativePath, value) {
  const filePath = path.join(fixtureDirectory, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
}

try {
  assert.equal(resolveBundlePath(fixtureDirectory, "../../outside.json"), null);
  const gate = new DesignSystemGate();
  assert.equal(gate.canWrite("figma-a"), false);
  assert.equal(gate.canWrite("figma-b"), false);
  gate.markPlanned("figma-a");
  assert.equal(gate.canWrite("figma-a"), true);
  assert.equal(gate.canWrite("figma-b"), false);
  gate.markContextLoaded("figma-b");
  assert.equal(gate.canWrite("figma-b"), true);
  const testSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>';
  const testSvgSha256 = createHash("sha256").update(testSvg).digest("hex");
  writeJson("manifest.json", {
    schemaVersion: 1,
    id: "test-design-system",
    name: "Test Design System",
    version: "1.0.0",
    entrypoints: {
      styles: "styles/styles.json",
      variables: "tokens/variables.resolved.json",
      components: "components/catalog.json",
      semanticCatalog: "semantic/catalog.json",
      fontManifest: "fonts/manifest.json",
      recipes: "recipes",
      productCatalog: "product/catalog.json",
      semanticAssets: "assets/semantic-catalog.json",
      checksums: "checksums.json",
    },
  });
  writeJson("styles/styles.json", {});
  writeJson("tokens/variables.resolved.json", { collections: [] });
  writeJson("components/catalog.json", [{
    id: "asset:1",
    name: "Gift",
    category: "icons",
    assetPath: "assets/svg/gift.svg",
    assetStatus: "exported",
    width: 24,
    height: 24,
  }]);
  writeText("assets/svg/gift.svg", testSvg);
  writeJson("assets/semantic-catalog.json", {
    schemaVersion: 1,
    assets: [{
      id: "merchant.test",
      kind: "merchant-logo",
      displayName: "Test Merchant",
      aliases: ["merchant demo"],
      artifact: {
        path: "assets/svg/gift.svg",
        mimeType: "image/svg+xml",
        width: 24,
        height: 24,
        status: "ready",
      },
    }],
  });
  writeJson("checksums.json", {
    algorithm: "sha256",
    files: [{
      path: "assets/svg/gift.svg",
      size: Buffer.byteLength(testSvg),
      sha256: testSvgSha256,
    }],
  });
  writeJson("product/catalog.json", {
    schemaVersion: 1,
    intents: [{
      id: "voucher",
      name: "Voucher",
      keywords: ["ví ưu đãi", "voucher"],
      patternIds: ["voucher-pocket"],
      journeyIds: ["voucher-flow"],
      recipeIds: ["test-screen"],
    }],
    patterns: [{
      id: "voucher-pocket",
      name: "Voucher Pocket",
      keywords: ["quản lý voucher"],
      recipeIds: ["test-screen"],
      screens: ["pocket.default"],
      states: ["default", "empty"],
      assetQueries: ["merchant demo"],
      referenceIds: ["voucher-reference"],
    }],
    journeys: [{
      id: "voucher-flow",
      name: "Voucher flow",
      keywords: ["end to end"],
      screens: ["home.default", "pocket.default", "payment.success"],
      states: ["loading", "success"],
      prototype: {
        start: "home.default",
        edges: [{ from: "home.default", to: "pocket.default" }],
      },
    }],
    references: [{
      id: "voucher-reference",
      name: "Voucher candidate",
      approval: "candidate",
    }],
    validation: {
      maxRepairPasses: 2,
      requirePrototypeNoDeadEnds: true,
    },
  });
  writeJson("fonts/manifest.json", { required: [] });
  writeJson("semantic/catalog.json", {
    schemaVersion: 1,
    fonts: { primary: null, allowedFamilies: [] },
    spacing: { "spacing/md": 8, "spacing/xl": 16 },
    typography: {
      title: { fontFamily: "Test Sans", fontWeight: "Bold", fontSize: 16, lineHeight: 24 },
      body: { fontFamily: "Test Sans", fontWeight: "Regular", fontSize: 14, lineHeight: 22 },
    },
    policies: ["Use semantic typography.", "Validate before handoff."],
  });
  writeJson("recipes/test-screen.json", {
    schemaVersion: 1,
    id: "test-screen",
    name: "Test Screen",
    viewport: { width: 393, height: 924 },
    required: [
      { name: "Title", type: "TEXT" },
      { name: "Body", type: "TEXT" },
      { name: "Primary Action", type: "INSTANCE" },
    ],
    nodeRules: [
      {
        name: "Title",
        type: "TEXT",
        typography: {
          fontFamily: "Test Sans",
          fontWeight: "Bold",
          fontSize: 16,
          lineHeight: 24,
        },
      },
      {
        name: "Primary Action",
        type: "INSTANCE",
        width: 93,
        height: 32,
        layoutMode: "HORIZONTAL",
      },
    ],
    generator: {
      blueprint: {
        screen: { layout: "VERTICAL", itemSpacing: 16 },
      },
    },
  });

  const manager = createDesignSystemManager({ bundlePath: fixtureDirectory });
  const status = manager.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.ready, true);
  assert.deepEqual(status.recipes, ["test-screen"]);
  assert.equal(status.productKnowledge.intents, 1);
  assert.equal(status.productKnowledge.patterns, 1);
  assert.equal(status.assets, 2);

  const context = manager.buildContext("test-screen");
  assert.match(context, /Mandatory policies/);
  assert.match(context, /Auto Layout blueprint/);
  assert.match(context, /figma_validate/);

  const plan = manager.createPlan(
    "Thiết kế end-to-end journey quản lý voucher từ Ví ưu đãi",
  );
  assert.equal(plan.mode, "product-guided");
  assert.equal(plan.matchedIntents[0].id, "voucher");
  assert.ok(plan.recipes.some(recipe => recipe.id === "test-screen"));
  assert.ok(plan.screens.includes("home.default"));
  assert.ok(plan.screens.includes("pocket.default"));
  assert.ok(plan.references.some(reference => reference.id === "voucher-reference"));
  assert.ok(plan.assets.some(asset => asset.id === "merchant.test"));
  assert.equal(plan.validation.maxRepairPasses, 2);

  const unknownPlan = manager.createPlan("Tạo báo cáo giao dịch định kỳ");
  assert.equal(unknownPlan.mode, "design-system-only");
  assert.deepEqual(unknownPlan.matchedIntents, []);
  assert.deepEqual(unknownPlan.recipes, []);
  assert.match(unknownPlan.fallback, /No product pattern matched/);

  const assets = manager.searchAssets("merchant demo");
  assert.equal(assets[0].id, "merchant.test");
  const importedAsset = manager.readAsset("merchant.test");
  assert.equal(importedAsset.buffer.toString("utf8"), testSvg);
  assert.equal(importedAsset.asset.checksumVerified, true);

  const strictResolverWithoutChecksum = new BundleAssetResolver({
    bundlePath: fixtureDirectory,
    semanticAssets: [{
      id: "merchant.test",
      displayName: "Test Merchant",
      artifact: {
        path: "assets/svg/gift.svg",
        mimeType: "image/svg+xml",
        status: "ready",
      },
    }],
    checksums: { files: [] },
    requireChecksums: true,
  });
  assert.throws(
    () => strictResolverWithoutChecksum.read("merchant.test"),
    /checksum entry is missing/,
  );

  let createPayload = null;
  const bridge = {
    async sendOperation(operation, params) {
      assert.equal(operation, "create");
      createPayload = params;
      return { id: "created:1" };
    },
  };
  const assetWrite = await executeCode(
    'return await figma.loadBundleAsset("merchant.test", { width: 36, height: 36 });',
    bridge,
    null,
    { loadBundleAsset: (reference, options) => manager.readAsset(reference, options) },
  );
  assert.equal(assetWrite.success, true, assetWrite.error);
  assert.equal(createPayload.type, "SVG");
  assert.equal(createPayload.width, 36);
  assert.match(createPayload.svg, /<svg/);
  writeText("assets/svg/gift.svg", `${testSvg}\n<!-- tampered -->`);
  assert.throws(
    () => manager.readAsset("merchant.test"),
    /checksum mismatch/,
  );

  const validTree = {
    id: "1:1",
    name: "Test Screen",
    type: "FRAME",
    width: 393,
    height: 924,
    children: [
      {
        id: "1:2",
        name: "Title",
        type: "TEXT",
        x: 16,
        y: 16,
        width: 100,
        height: 24,
        fontFamily: "Test Sans",
        fontWeight: "Bold",
        fontSize: 16,
        lineHeight: 24,
      },
      {
        id: "1:3",
        name: "Body",
        type: "TEXT",
        x: 16,
        y: 48,
        width: 200,
        height: 22,
        fontFamily: "Test Sans",
        fontWeight: "Regular",
        fontSize: 14,
        lineHeight: 22,
      },
      {
        id: "1:4",
        name: "Primary Action",
        type: "INSTANCE",
        x: 16,
        y: 86,
        width: 93,
        height: 32,
        layout: { mode: "HORIZONTAL" },
      },
    ],
  };
  const validResult = manager.validate(validTree, "test-screen");
  assert.equal(validResult.ok, true, JSON.stringify(validResult.findings, null, 2));
  assert.equal(validResult.counts.error, 0);

  const invalidTree = structuredClone(validTree);
  invalidTree.width = 390;
  invalidTree.children[2].width = 100;
  const invalidResult = manager.validate(invalidTree, "test-screen");
  assert.equal(invalidResult.ok, false);
  assert.ok(invalidResult.findings.some(finding => finding.code === "viewport-width"));
  assert.ok(invalidResult.findings.some(finding => finding.code === "node-width"));

  console.log("Design-system runtime tests passed.");
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
