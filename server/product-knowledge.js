const STOP_WORDS = new Set([
  "a", "an", "and", "app", "cho", "cua", "design", "figma", "for", "giao",
  "hay", "in", "la", "lam", "man", "mot", "of", "on", "screen", "tao",
  "the", "thiet", "to", "tren", "ui", "va", "voi",
]);

export function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value) {
  return [...new Set(normalizeSearchText(value).split(/\s+/).filter(token =>
    token.length > 1 && !STOP_WORDS.has(token),
  ))];
}

function searchablePhrases(candidate) {
  return [
    candidate?.id,
    candidate?.name,
    candidate?.description,
    ...(candidate?.keywords || []),
    ...(candidate?.aliases || []),
    ...(candidate?.intents || []),
    ...(candidate?.screenTypes || []),
  ].filter(Boolean);
}

function scoreCandidate(candidate, prompt, promptTokens) {
  const normalizedPrompt = normalizeSearchText(prompt);
  let score = 0;
  const reasons = [];

  for (const rawPhrase of searchablePhrases(candidate)) {
    const phrase = normalizeSearchText(rawPhrase);
    if (!phrase) continue;
    if (normalizedPrompt === phrase) {
      score += 24;
      reasons.push(`exact:${rawPhrase}`);
      continue;
    }
    if (phrase.length > 2 && normalizedPrompt.includes(phrase)) {
      score += phrase.includes(" ") ? 10 : 6;
      reasons.push(`phrase:${rawPhrase}`);
    }
    const phraseTokens = tokens(phrase);
    const overlap = phraseTokens.filter(token => promptTokens.includes(token));
    if (overlap.length) {
      score += overlap.length * 2;
      reasons.push(`tokens:${overlap.join(",")}`);
    }
  }

  return { score, reasons: [...new Set(reasons)] };
}

function rank(candidates, prompt, { limit = 5, minimumScore = 1 } = {}) {
  const promptTokens = tokens(prompt);
  return (candidates || [])
    .map(candidate => ({ candidate, ...scoreCandidate(candidate, prompt, promptTokens) }))
    .filter(result => result.score >= minimumScore)
    .sort((left, right) =>
      right.score - left.score ||
      Number(right.candidate.priority || 0) - Number(left.candidate.priority || 0) ||
      String(left.candidate.id || left.candidate.name).localeCompare(
        String(right.candidate.id || right.candidate.name),
      ),
    )
    .slice(0, limit);
}

function byId(items) {
  return new Map((items || []).filter(item => item?.id).map(item => [item.id, item]));
}

function selectLinked(items, ids) {
  const index = byId(items);
  return [...new Set(ids || [])].map(id => index.get(id)).filter(Boolean);
}

function compactMatch(result) {
  return {
    id: result.candidate.id,
    name: result.candidate.name || result.candidate.id,
    score: result.score,
    reasons: result.reasons,
  };
}

export function buildProductPlan({
  prompt,
  catalog = {},
  recipes = [],
  explicitRecipe = null,
  searchAssets = () => [],
  maxAssets = 12,
} = {}) {
  const safePrompt = String(prompt || "").trim();
  if (!safePrompt) throw new Error("'prompt' is required.");

  const intents = catalog.intents || [];
  const patterns = catalog.patterns || [];
  const journeys = catalog.journeys || [];
  const references = catalog.references || [];
  const recipeRows = recipes.map(recipe => ({
    ...recipe,
    keywords: [
      ...(recipe.keywords || []),
      ...(recipe.intents || []),
      recipe.id,
      recipe.name,
    ].filter(Boolean),
  }));

  const intentMatches = rank(intents, safePrompt, { limit: 5, minimumScore: 2 });
  const linkedPatternIds = intentMatches.flatMap(match => match.candidate.patternIds || []);
  const linkedJourneyIds = intentMatches.flatMap(match => match.candidate.journeyIds || []);
  const linkedRecipeIds = intentMatches.flatMap(match => match.candidate.recipeIds || []);

  const directPatternMatches = rank(patterns, safePrompt, { limit: 8, minimumScore: 2 });
  const linkedPatterns = selectLinked(patterns, linkedPatternIds).map(candidate => ({
    candidate,
    score: 50 + Number(candidate.priority || 0),
    reasons: ["linked-intent"],
  }));
  const patternMatches = [...linkedPatterns, ...directPatternMatches]
    .filter((match, index, rows) =>
      rows.findIndex(other => other.candidate.id === match.candidate.id) === index,
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);

  const directJourneyMatches = rank(journeys, safePrompt, { limit: 3, minimumScore: 2 });
  const linkedJourneys = selectLinked(journeys, linkedJourneyIds).map(candidate => ({
    candidate,
    score: 50 + Number(candidate.priority || 0),
    reasons: ["linked-intent"],
  }));
  const journeyMatches = [...linkedJourneys, ...directJourneyMatches]
    .filter((match, index, rows) =>
      rows.findIndex(other => other.candidate.id === match.candidate.id) === index,
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);

  const requestedRecipeIds = [
    explicitRecipe,
    ...linkedRecipeIds,
    ...patternMatches.flatMap(match => match.candidate.recipeIds || []),
    ...journeyMatches.flatMap(match => match.candidate.recipeIds || []),
  ].filter(Boolean);
  const directRecipeMatches = rank(recipeRows, safePrompt, { limit: 5, minimumScore: 2 });
  const recipeIndex = byId(recipeRows);
  const selectedRecipes = [
    ...requestedRecipeIds.map(id => recipeIndex.get(id)).filter(Boolean),
    ...directRecipeMatches.map(match => match.candidate),
  ].filter((recipe, index, rows) =>
    rows.findIndex(other => other.id === recipe.id) === index,
  );

  if (explicitRecipe && !recipeIndex.has(explicitRecipe)) {
    throw new Error(`Recipe not found: ${explicitRecipe}`);
  }

  const referenceIds = [
    ...patternMatches.flatMap(match => match.candidate.referenceIds || []),
    ...journeyMatches.flatMap(match => match.candidate.referenceIds || []),
  ];
  const selectedReferences = selectLinked(references, referenceIds);

  const assetQueries = [
    ...patternMatches.flatMap(match => match.candidate.assetQueries || []),
    ...journeyMatches.flatMap(match => match.candidate.assetQueries || []),
  ];
  const promptAssetTerms = tokens(safePrompt).filter(token =>
    !["voucher", "pocket", "payment", "home", "detail", "journey"].includes(token),
  );
  const assets = [
    ...assetQueries.flatMap(query => searchAssets(query, { limit: 3 })),
    ...(promptAssetTerms.length
      ? searchAssets(promptAssetTerms.join(" "), { limit: maxAssets })
      : []),
  ].filter((asset, index, rows) =>
    rows.findIndex(other =>
      other.id === asset.id ||
      (other.assetPath && asset.assetPath && other.assetPath === asset.assetPath),
    ) === index,
  ).slice(0, maxAssets);

  const screens = [
    ...journeyMatches.flatMap(match => match.candidate.screens || []),
    ...patternMatches.flatMap(match => match.candidate.screens || []),
  ].filter((screen, index, rows) => {
    const id = typeof screen === "string" ? screen : screen.id;
    return rows.findIndex(other => (typeof other === "string" ? other : other.id) === id) === index;
  });
  const states = [
    ...journeyMatches.flatMap(match => match.candidate.states || []),
    ...patternMatches.flatMap(match => match.candidate.states || []),
  ].filter((state, index, rows) => rows.indexOf(state) === index);

  const hasKnowledge = intentMatches.length || patternMatches.length ||
    journeyMatches.length || selectedRecipes.length;

  return {
    schemaVersion: 1,
    mode: hasKnowledge ? "product-guided" : "design-system-only",
    prompt: safePrompt,
    matchedIntents: intentMatches.map(compactMatch),
    matchedPatterns: patternMatches.map(compactMatch),
    matchedJourneys: journeyMatches.map(compactMatch),
    patternGuidance: patternMatches.map(match => ({
      id: match.candidate.id,
      name: match.candidate.name || match.candidate.id,
      description: match.candidate.description || null,
      instructions: match.candidate.instructions || [],
      recipeIds: match.candidate.recipeIds || [],
      states: match.candidate.states || [],
      assetQueries: match.candidate.assetQueries || [],
    })),
    journeyGuidance: journeyMatches.map(match => ({
      id: match.candidate.id,
      name: match.candidate.name || match.candidate.id,
      screens: match.candidate.screens || [],
      states: match.candidate.states || [],
      prototype: match.candidate.prototype || null,
    })),
    recipes: selectedRecipes.map(recipe => ({
      id: recipe.id,
      name: recipe.name || recipe.id,
      viewport: recipe.viewport || null,
    })),
    screens,
    states,
    references: selectedReferences,
    assets,
    prototype: journeyMatches[0]?.candidate?.prototype || null,
    preflight: [
      "Call design_system_status and stop if required fonts are unavailable.",
      "Read design_system_context for every selected recipe before writing.",
      "Resolve bundled icons and merchant marks with design_system_assets; do not redraw them with primitive geometry.",
      "Use the exact asset IDs returned by the plan. External icon libraries are fallback-only when no bundle alias exists.",
      "Preserve existing canvas content and place generated groups in unused space.",
    ],
    generationOrder: screens.length
      ? screens.map(screen => typeof screen === "string" ? screen : screen.id)
      : selectedRecipes.map(recipe => recipe.id),
    validation: {
      maxRepairPasses: Number(catalog.validation?.maxRepairPasses || 3),
      requireZeroErrors: catalog.validation?.requireZeroErrors !== false,
      requirePrototypeNoDeadEnds: Boolean(catalog.validation?.requirePrototypeNoDeadEnds),
      checks: catalog.validation?.checks || [
        "font",
        "typography",
        "spacing",
        "overflow",
        "component-consistency",
        "asset-placeholder",
        "prototype-destinations",
      ],
      loop: [
        "Run figma_validate on each generated root frame.",
        "Fix every error and review warnings that affect visual quality.",
        "Read a screenshot at 1x and inspect hierarchy, density, clipping, and merchant assets.",
        "Repeat validation after every repair pass.",
      ],
    },
    fallback:
      hasKnowledge
        ? null
        : "No product pattern matched. Use global design-system rules, then ask for a reviewed recipe before production reuse.",
  };
}
