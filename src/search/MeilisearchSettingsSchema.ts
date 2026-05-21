export const MEILISEARCH_SETTING_KEYS = new Set([
  "displayedAttributes",
  "searchableAttributes",
  "filterableAttributes",
  "sortableAttributes",
  "rankingRules",
  "stopWords",
  "synonyms",
  "distinctAttribute",
  "typoTolerance",
  "faceting",
  "pagination",
  "separatorTokens",
  "nonSeparatorTokens",
  "dictionary",
  "proximityPrecision",
  "searchCutoffMs",
  "localizedAttributes",
  "embedders",
  "facetSearch",
  "prefixSearch",
]);

export interface SettingsValidationResult {
  unknown: string[];
  ok: boolean;
}

export function validateMeilisearchSettings(
  settings: Record<string, unknown>,
): SettingsValidationResult {
  const unknown = Object.keys(settings).filter((k) => !MEILISEARCH_SETTING_KEYS.has(k));
  return { unknown, ok: unknown.length === 0 };
}

export class InvalidMeilisearchSettingsError extends Error {
  constructor(public readonly unknown: string[]) {
    super(
      `Unknown Meilisearch settings keys: ${unknown.join(", ")}. ` +
      `Valid keys: ${[...MEILISEARCH_SETTING_KEYS].join(", ")}. ` +
      `Pass { validate: false } to MeilisearchEngine to skip this check.`,
    );
  }
}
