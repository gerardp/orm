import type { MatchPosition, SearchQuery } from "./SearchEngine.js";

const OPERATOR_WORDS = new Set(["AND", "OR", "NOT", "NEAR"]);

export function computeMatchesPosition(
  query: SearchQuery,
  data: Record<string, unknown>,
  fields: readonly string[],
): Record<string, MatchPosition[]> | undefined {
  const terms = extractSearchTerms(query.query);
  if (terms.length === 0) return undefined;

  const out: Record<string, MatchPosition[]> = {};
  for (const field of fields) {
    const value = data[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const positions = findTermPositions(value, terms);
    if (positions.length > 0) out[field] = positions;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function extractSearchTerms(query: string): string[] {
  const terms = new Set<string>();
  const matches = query.match(/[\p{L}\p{N}_]+(?::\*)?\*?/gu) ?? [];
  for (const raw of matches) {
    const term = raw.replace(/(?::\*)?\*$/u, "");
    if (term.length === 0) continue;
    if (OPERATOR_WORDS.has(term.toUpperCase())) continue;
    terms.add(term.toLocaleLowerCase());
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

function findTermPositions(value: string, terms: readonly string[]): MatchPosition[] {
  const lower = value.toLocaleLowerCase();
  const positions: MatchPosition[] = [];

  for (const term of terms) {
    let start = 0;
    while (start < lower.length) {
      const idx = lower.indexOf(term, start);
      if (idx === -1) break;
      positions.push({ start: idx, length: term.length });
      start = idx + Math.max(1, term.length);
    }
  }

  return positions
    .sort((a, b) => a.start - b.start || b.length - a.length)
    .filter((pos, index, all) => !all.some((other, otherIndex) =>
      otherIndex < index &&
      pos.start >= other.start &&
      pos.start + pos.length <= other.start + other.length
    ));
}
