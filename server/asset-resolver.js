import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeSearchText } from "./product-knowledge.js";

const MIME_BY_EXTENSION = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function safeResolve(root, relativePath) {
  if (!root || !relativePath || path.isAbsolute(relativePath)) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }
  if (existsSync(resolvedRoot) && existsSync(resolved)) {
    const realRoot = realpathSync(resolvedRoot);
    const realResolved = realpathSync(resolved);
    if (realResolved !== realRoot && !realResolved.startsWith(`${realRoot}${path.sep}`)) {
      return null;
    }
  }
  return resolved;
}

function checksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function asAsset(row, source) {
  if (!row?.assetPath) return null;
  const extension = path.extname(row.assetPath).toLowerCase();
  return {
    id: row.id || row.key || row.assetPath,
    key: row.key || null,
    name: row.name || path.basename(row.assetPath, extension),
    aliases: row.aliases || [],
    category: row.category || source,
    source,
    page: row.page || row.pageName || null,
    assetPath: row.assetPath,
    assetStatus: row.assetStatus || "exported",
    mimeType: MIME_BY_EXTENSION[extension] || "application/octet-stream",
    width: row.width ?? null,
    height: row.height ?? null,
  };
}

function asSemanticAsset(row) {
  const assetPath = row?.artifact?.path || row?.assetPath;
  if (!assetPath) return null;
  const extension = path.extname(assetPath).toLowerCase();
  return {
    id: row.id,
    key: row.component?.key || row.key || null,
    name: row.displayName || row.name || row.id,
    aliases: row.aliases || [],
    category: row.kind || "semantic",
    source: "semantic",
    page: row.component?.page || null,
    assetPath,
    assetStatus: row.artifact?.status === "ready"
      ? "exported"
      : row.artifact?.status || row.assetStatus || "exported",
    mimeType: row.artifact?.mimeType || MIME_BY_EXTENSION[extension] ||
      "application/octet-stream",
    width: row.artifact?.width ?? row.width ?? null,
    height: row.artifact?.height ?? row.height ?? null,
    usage: row.usage || null,
  };
}

function scoreAsset(asset, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 1;
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const name = normalizeSearchText(asset.name);
  const id = normalizeSearchText(asset.id);
  const aliases = (asset.aliases || []).map(normalizeSearchText);
  const searchable = normalizeSearchText([
    asset.name,
    asset.id,
    asset.key,
    asset.category,
    asset.page,
    ...(asset.aliases || []),
  ].filter(Boolean).join(" "));

  let score = 0;
  if (name === normalizedQuery || id === normalizedQuery || aliases.includes(normalizedQuery)) {
    score += 100;
  }
  if (name.includes(normalizedQuery)) score += 30;
  if (searchable.includes(normalizedQuery)) score += 15;
  score += queryTokens.filter(token => searchable.includes(token)).length * 4;
  if (asset.source === "semantic") score += 50;
  if (asset.assetStatus === "exported") score += 2;
  return score;
}

export class BundleAssetResolver {
  constructor({
    bundlePath,
    components = [],
    images = [],
    semanticAssets = [],
    aliases = {},
    checksums = {},
    requireChecksums = false,
  } = {}) {
    this.bundlePath = bundlePath;
    this.requireChecksums = requireChecksums;
    this.checksums = new Map(
      (checksums.files || []).map(file => [String(file.path).replaceAll("\\", "/"), file]),
    );
    const aliasRows = Array.isArray(aliases) ? aliases : aliases.assets || [];
    const aliasesByTarget = new Map();
    for (const alias of aliasRows) {
      const target = alias.assetId || alias.assetPath || alias.target;
      if (!target) continue;
      if (!aliasesByTarget.has(target)) aliasesByTarget.set(target, []);
      aliasesByTarget.get(target).push(
        ...[alias.alias, alias.name, alias.id].filter(Boolean),
      );
    }

    this.assets = [
      ...semanticAssets.map(asSemanticAsset),
      ...components.map(row => asAsset(row, "component")),
      ...images.map(row => asAsset(row, "image")),
    ].filter(Boolean).map(asset => ({
      ...asset,
      aliases: [
        ...(asset.aliases || []),
        ...(aliasesByTarget.get(asset.id) || []),
        ...(aliasesByTarget.get(asset.assetPath) || []),
      ].filter(Boolean),
    }));
  }

  search(query, { limit = 12, source = null, category = null } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
    return this.assets
      .filter(asset => asset.assetStatus === "exported")
      .filter(asset => !source || asset.source === source)
      .filter(asset => !category || asset.category === category)
      .map(asset => ({ asset, score: scoreAsset(asset, query) }))
      .filter(result => result.score > 0)
      .sort((left, right) =>
        right.score - left.score ||
        String(left.asset.name).localeCompare(String(right.asset.name)) ||
        String(left.asset.id).localeCompare(String(right.asset.id)),
      )
      .slice(0, safeLimit)
      .map(({ asset, score }) => ({
        ...asset,
        score,
        available: Boolean(safeResolve(this.bundlePath, asset.assetPath) &&
          existsSync(safeResolve(this.bundlePath, asset.assetPath))),
      }));
  }

  findExact(reference, { source = null, categories = null } = {}) {
    const normalizedReference = normalizeSearchText(reference);
    if (!normalizedReference) return [];
    const acceptedCategories = new Set(
      (Array.isArray(categories) ? categories : categories ? [categories] : [])
        .map(normalizeSearchText),
    );
    return this.assets
      .filter(asset => asset.assetStatus === "exported")
      .filter(asset => !source || asset.source === source)
      .filter(asset =>
        !acceptedCategories.size ||
        acceptedCategories.has(normalizeSearchText(asset.category)),
      )
      .filter(asset => [
        asset.id,
        asset.key,
        asset.assetPath,
        asset.name,
        ...(asset.aliases || []),
      ].some(value => normalizeSearchText(value) === normalizedReference))
      .sort((left, right) =>
        Number(right.source === "semantic") - Number(left.source === "semantic") ||
        String(left.id).localeCompare(String(right.id)),
      );
  }

  resolveExact(reference, options = {}) {
    const exact = this.findExact(reference, options);
    if (!exact.length) return null;
    const uniqueTargets = new Set(exact.map(asset => asset.assetPath));
    if (uniqueTargets.size > 1) {
      throw new Error(
        `Bundle asset reference is ambiguous: ${reference}. Use an exact id or assetPath.`,
      );
    }
    return exact[0];
  }

  resolve(reference) {
    const raw = String(reference || "").trim();
    if (!raw) throw new Error("Asset reference is required.");
    const exact = this.findExact(raw);
    const candidates = exact.length ? exact : this.search(raw, { limit: 2 });
    if (!candidates.length) throw new Error(`Bundle asset not found: ${raw}`);
    if (!exact.length && candidates.length > 1 && candidates[0].score === candidates[1].score) {
      throw new Error(
        `Bundle asset reference is ambiguous: ${raw}. Use an exact id or assetPath.`,
      );
    }
    return exact[0] || candidates[0];
  }

  read(reference, { maxBytes = 5_000_000 } = {}) {
    const asset = this.resolve(reference);
    const absolutePath = safeResolve(this.bundlePath, asset.assetPath);
    if (!absolutePath) throw new Error("Bundle asset path escapes the configured bundle.");
    if (!existsSync(absolutePath)) throw new Error(`Bundle asset is missing: ${asset.assetPath}`);
    const size = statSync(absolutePath).size;
    if (size > maxBytes) {
      throw new Error(`Bundle asset exceeds ${maxBytes} bytes: ${asset.assetPath}`);
    }
    const buffer = readFileSync(absolutePath);
    const checksumRecord = this.checksums.get(asset.assetPath.replaceAll("\\", "/"));
    const actualChecksum = checksum(buffer);
    if (this.requireChecksums && !checksumRecord?.sha256) {
      throw new Error(`Bundle asset checksum entry is missing: ${asset.assetPath}`);
    }
    if (checksumRecord?.sha256 && checksumRecord.sha256 !== actualChecksum) {
      throw new Error(`Bundle asset checksum mismatch: ${asset.assetPath}`);
    }
    return {
      asset: {
        ...asset,
        size,
        sha256: actualChecksum,
        checksumVerified: Boolean(checksumRecord?.sha256),
      },
      buffer,
    };
  }
}

export function resolveBundlePath(root, relativePath) {
  return safeResolve(root, relativePath);
}
