import type { CmpOp } from "./SearchEngine.js";

const SEARCH_OPERATORS = new Set<CmpOp>(["=", "!=", ">", ">=", "<", "<="]);

export function validSearchOperator(value: unknown): CmpOp {
  if (!SEARCH_OPERATORS.has(value as CmpOp)) {
    throw new Error(`Invalid search comparison operator: ${String(value)}`);
  }
  return value as CmpOp;
}

export function validSearchDirection(value: unknown): "asc" | "desc" {
  const direction = String(value).toLowerCase();
  if (direction !== "asc" && direction !== "desc") {
    throw new Error(`Invalid search order direction: ${String(value)}`);
  }
  return direction;
}

export function finiteSearchNumber(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

export function nonNegativeSearchInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

export function positiveSearchInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}
