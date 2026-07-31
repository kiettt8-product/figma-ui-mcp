# Changelog

This file records changes made in the Kiettt8 custom edition. The repository
started from the MIT-licensed
[TranHoaiHung/figma-ui-mcp](https://github.com/TranHoaiHung/figma-ui-mcp);
the upstream history remains available through Git.

## Unreleased

### Added

- Portable design-system bundle runtime with font preflight, semantic context
  and recipe-based validation.
- Deterministic `design_system_plan` routing for product intents, screens,
  states, assets and prototype flows.
- Checksum-verified `design_system_assets` lookup and
  `figma.loadBundleAsset(...)` import.
- Session-scoped design-system gate before Figma writes.
- Product knowledge for the ZaloPay voucher journey, packaged separately from
  the public source repository.
- Bundle-first icon resolution through semantic aliases.
- Asset provenance metadata on imported Figma nodes: bundle ID, version, asset
  ID and checksum.
- Validator errors for hand-drawn icons and external-library icons when an
  exact bundle asset exists.

### Changed

- `figma.loadIcon()` now checks the configured design-system bundle before
  using Ionicons, Fluent, Bootstrap, Phosphor, Tabler or Lucide.
- Added bridge service identity and protocol checks.
- Unknown services occupying the bridge port are no longer terminated.
- Public npm and MCP Registry publishing is disabled until an approved package
  scope and internal distribution policy exist.
- Removed stale upstream registry metadata, prebuilt plugin archives and legacy
  branding assets.

## 2.5.27 — 2026-07-30

### Added

- One-command setup for Codex, Claude Code, Claude Desktop, Cursor, VS Code and
  Windsurf.
- Background bridge service for macOS, Windows and Linux.
- Custom light Figma plugin UI.
- Multi-session Figma bridge and prototype operations.

### Security

- Bridge binds to `127.0.0.1` by default.
- Setup preserves unrelated MCP configuration and creates backups before
  modifying client files.
