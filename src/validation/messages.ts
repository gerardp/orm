import type { RuleContract, ValidationContext } from "./types.js";

export type MessageOverrides = Record<string, string>;

/**
 * Renders `:attribute` (and any other `:placeholder` supplied in `params`) in a
 * message template. Built-in messages interpolate at construction time, so
 * before this existed a custom override was the only message that reached the
 * user with a literal `:attribute` in it.
 */
export function interpolate(
  template: string,
  params: { attribute: string; [key: string]: unknown },
): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function resolveMessage(
  overrides: MessageOverrides,
  field: string,
  rule: RuleContract,
  ctx: ValidationContext,
): string {
  const override =
    overrides[`${field}.${rule.name}`] ??
    overrides[field] ??
    overrides[`${ctx.pattern}.${rule.name}`] ??
    overrides[ctx.pattern];

  if (override === undefined) return rule.message(ctx);

  return interpolate(override, {
    attribute: ctx.attribute,
    field: ctx.attribute,
    rule: rule.name,
  });
}
