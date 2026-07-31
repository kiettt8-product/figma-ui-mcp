// MCP tool schema definitions
export const TOOLS = [
  {
    name: "figma_status",
    description:
      "Check whether the Figma plugin bridge is connected. " +
      "Always call this first to confirm the plugin is running before any other tool.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "figma_write",
    description:
      "Execute JavaScript code to CREATE or MODIFY designs in Figma. " +
      "⚠️ MANDATORY: Call figma_docs BEFORE writing any design code. Skipping figma_docs causes hardcoded colors, wrong sizing, broken layouts, and low-quality UI. " +
      "When a design-system bundle is configured, call design_system_plan with the user's full request before writing; the server enforces this gate. " +
      "Use figma.loadBundleAsset(reference, opts) for resolved internal SVG or raster assets, then call figma_validate after writing. " +
      "Use the `figma` proxy object — all methods return Promises, use async/await. " +
      "Operations: create, modify, delete, clone, group, ungroup, flatten, resize, " +
      "set_selection, set_viewport, batch (multiple ops in one call). " +
      "Design Tokens: createVariableCollection, createVariable, setVariableValue, " +
      "addVariableMode, renameVariableMode, removeVariableMode, applyVariable, " +
      "setFrameVariableMode, clearFrameVariableMode, " +
      "createPaintStyle, createTextStyle, createComponent. " +
      "Prototyping: setReactions, getReactions, removeReactions (click/hover/press → navigate/overlay/swap with Smart Animate transitions). " +
      "Scroll: setScrollBehavior (overflowDirection: NONE/HORIZONTAL/VERTICAL/BOTH). " +
      "Variants: setComponentProperties, swapComponent, getComponentProperties. " +
      "Component property definitions (master-side, required for instance text overrides to recalc auto-layout): " +
      "addComponentProperty (TEXT/BOOLEAN/INSTANCE_SWAP), bindComponentPropertyToText, removeComponentProperty. " +
      "The code runs in a sandboxed VM: no access to require, process, fs, fetch, or network.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript using figma.create(), figma.modify(), figma.setPage(), etc.",
        },
        sessionId: {
          type: "string",
          description: "Target a specific Figma file/tab when multiple are connected. Omit to auto-select.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "figma_read",
    description:
      "READ design data from Figma — extract node trees, colors, typography, spacing, and screenshots. " +
      "Use to understand an existing design before generating code, or to inspect what's on the canvas.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [
            "get_selection", "get_design", "get_page_nodes", "screenshot", "export_svg",
            "get_styles", "get_local_components", "get_viewport", "get_variables",
            "get_node_detail", "get_css",
            "get_design_context", "get_component_map", "get_unmapped_components",
            "getReactions",
            "export_image",
            "search_nodes",
            "scan_design"
          ],
          description:
            "── Design-to-code (use these for code generation) ──\n" +
            "get_design_context: AI-optimized payload for a node — flex layout, token-resolved colors, typography with style names, component instances with variant properties. Best single call for design→React/Vue/Swift code.\n" +
            "get_css: ready-to-use CSS string for a single node — background, flex, border, radius, shadow, typography, opacity, transform.\n" +
            "get_component_map: list every component instance in a frame with componentSetName, variantLabel, properties, and suggestedImport path. Use to scaffold import statements.\n" +
            "get_unmapped_components: find component instances that have no description in Figma (likely no code mapping yet). Prompts AI to ask user for correct import paths.\n" +
            "── Inspect ──\n" +
            "get_node_detail: structured properties for a single node — fills, bound variables (resolved to name+value), style refs (resolved to name+hex), instance overrides (full field list), componentSetName/variantLabel.\n" +
            "get_selection: full design tree of selected node(s) + design tokens summary.\n" +
            "get_design: full node tree for a frame/page (depth param: number or 'full').\n" +
            "get_page_nodes: top-level frames on the current page.\n" +
            "getReactions: prototype triggers and actions attached to a node.\n" +
            "── Styles & tokens ──\n" +
            "get_styles: all local paint, text, effect, grid styles.\n" +
            "get_variables: all local Design Token variables — collections, modes, resolved values.\n" +
            "get_local_components: component listing with descriptions + variant property definitions.\n" +
            "── Export ──\n" +
            "screenshot: PNG of a node — displays inline in Claude Code.\n" +
            "export_svg: SVG markup string.\n" +
            "export_image: base64 PNG/JPG for saving to disk (scale param for resolution).\n" +
            "── Search ──\n" +
            "search_nodes: filter by type, namePattern (wildcard *), fill color, fontFamily, fontSize, hasImage, hasIcon.\n" +
            "scan_design: structured summary of large frames — all text, colors, fonts, images, icons, sections.\n" +
            "── Viewport ──\n" +
            "get_viewport: current viewport center, zoom, bounds.",
        },
        nodeId:   { type: "string", description: "Target node ID (optional — omit to use current selection)." },
        nodeName: { type: "string", description: "Target node name (alternative to nodeId)." },
        scale:    { type: "number", description: "Export scale for screenshot (default 1)." },
        depth:    { type: "string", description: "Tree depth for get_design/get_selection. Number (default 10) or 'full' for unlimited. Higher = more detail but larger output." },
        format:   { type: "string", description: "Image format for export_image: 'png' (default) or 'jpg'." },
        detail:   { type: "string", description: "Detail level for get_design/get_selection: 'minimal' (~5% tokens), 'compact' (~30%), 'full' (default, 100%). Use minimal for large files." },
        includeHidden: { type: "boolean", description: "Include invisible nodes (visible:false) in results. Default false — hidden layers are skipped to reduce noise." },
        sessionId: { type: "string", description: "Target a specific Figma file/tab when multiple are connected. Omit to auto-select." },
      },
      required: ["operation"],
    },
  },
  {
    name: "figma_docs",
    description:
      "Get the API reference and design rules for figma_write. " +
      "Call with no args first — returns quick-start guide + critical rules. " +
      "Then load specific sections as needed: " +
      "section='rules' (design principles, token rules, layer order, component-first), " +
      "section='layout' (auto-layout, button/card/badge/progress/mobile rules), " +
      "section='api' (create/modify/delete/clone/batch/read operations + workflow), " +
      "section='tokens' (variables, multi-mode, paint styles, text styles), " +
      "section='icons' (loadImage, loadIcon, loadIconIn, icon libraries, coloring, sizing). " +
      "Always call figma_docs BEFORE any figma_write code.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["rules", "layout", "api", "tokens", "icons"],
          description:
            "Which section to load. Omit (or null) for quick-start + critical rules. " +
            "Load layout before any auto-layout work. Load api for full operation reference. " +
            "Load tokens for variable/multi-mode work. Load icons for image/icon placement.",
        },
      },
      required: [],
    },
  },
  {
    name: "figma_rules",
    description:
      "Generate a design system rule sheet from the current Figma file — aggregates color tokens, " +
      "typography styles, variables (all modes), and component catalog into a single markdown block. " +
      "Equivalent to official Figma MCP's create_design_system_rules. " +
      "Call once at the start of a design-to-code session to give the AI full context: " +
      "what tokens to use, what text styles exist, which components are available. " +
      "Re-run when the design system changes.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Target a specific Figma file/tab. Omit to auto-select.",
        },
      },
      required: [],
    },
  },
  {
    name: "design_system_status",
    description:
      "Inspect the configured portable design-system bundle and run dependency preflight. " +
      "Returns bundle version, available semantic recipes, required fonts, missing weights, and readiness. " +
      "Call this before generating a design that must follow an internal design system.",
    inputSchema: {
      type: "object",
      properties: {
        reload: {
          type: "boolean",
          description: "Reload the bundle manifest and semantic files from disk before checking.",
        },
      },
      required: [],
    },
  },
  {
    name: "design_system_context",
    description:
      "Load prompt-ready semantic design-system rules from the configured bundle. " +
      "Includes font dependencies, spacing tokens, typography roles, component roles, " +
      "generation policies, and an optional screen recipe with an Auto Layout blueprint. " +
      "Use this instead of guessing values from screenshots.",
    inputSchema: {
      type: "object",
      properties: {
        recipe: {
          type: "string",
          description:
            "Semantic recipe ID such as 'voucher-pocket'. Omit to load only global design-system rules.",
        },
        reload: {
          type: "boolean",
          description: "Reload bundle files before building context.",
        },
        sessionId: {
          type: "string",
          description:
            "Scope the pre-write gate to a specific Figma tab when multiple files are connected.",
        },
      },
      required: [],
    },
  },
  {
    name: "design_system_plan",
    description:
      "Turn the user's natural-language design request into a deterministic, bundle-backed " +
      "generation plan. Resolves product intent, screen patterns, recipes, states, candidate " +
      "golden references, bundled assets, prototype flow, and the validation/repair checklist. " +
      "MANDATORY before figma_write whenever a design-system bundle is configured. Pass the " +
      "user's complete request, not a shortened keyword.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The user's complete design request in Vietnamese or English.",
        },
        recipe: {
          type: "string",
          description: "Optional exact recipe override. Normally omit and let routing resolve it.",
        },
        maxAssets: {
          type: "number",
          minimum: 1,
          maximum: 50,
          description: "Maximum asset candidates included in the plan. Default 12.",
        },
        reload: {
          type: "boolean",
          description: "Reload bundle files before planning.",
        },
        sessionId: {
          type: "string",
          description:
            "Scope this plan to a specific Figma tab when multiple files are connected. " +
            "Use the same sessionId in figma_write.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "design_system_assets",
    description:
      "Search the configured portable bundle for checksum-addressable semantic assets, " +
      "component SVGs, icons, merchant marks, and raster images. Prefer an exact semantic " +
      "asset ID from design_system_plan. Import a result inside figma_write with " +
      "figma.loadBundleAsset(asset.id, opts); never draw a placeholder when a required " +
      "bundled asset exists.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Semantic ID, asset name, alias, merchant name, icon name, or keywords.",
        },
        source: {
          type: "string",
          enum: ["semantic", "component", "image"],
          description: "Optional asset source filter.",
        },
        category: {
          type: "string",
          description: "Optional category filter such as merchant-logo, icons, or brand-assets.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 50,
          description: "Maximum results. Default 12.",
        },
        reload: {
          type: "boolean",
          description: "Reload bundle files before searching.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "figma_validate",
    description:
      "Validate a generated Figma frame against the configured design-system bundle. " +
      "Checks fonts, typography roles, token colors, viewport, component dimensions, " +
      "repeated-item spacing, vertical rhythm, and recipe-specific padding. " +
      "Fix every error and re-run before handing the design to the user.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Root frame node ID to validate.",
        },
        nodeName: {
          type: "string",
          description: "Root frame name when nodeId is not known.",
        },
        recipe: {
          type: "string",
          description: "Semantic recipe ID to enforce.",
        },
        sessionId: {
          type: "string",
          description: "Target Figma file session when multiple files are connected.",
        },
      },
      required: [],
    },
  },
];
