export function snakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, "_$1")
    .toLowerCase()
    .replace(/^_+/, "");
}

export function normalizePathList(value?: string | string[]): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => item.trim()).filter((item) => item.length > 0);
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

const NUMERIC_COLUMN_TYPES = new Set([
  "int",
  "int2",
  "int4",
  "int8",
  "integer",
  "bigint",
  "smallint",
  "mediumint",
  "tinyint",
  "serial",
  "smallserial",
  "bigserial",
  "real",
  "float",
  "double",
  "decimal",
  "numeric",
]);

/**
 * Reduce a driver reported column type to its base name so the three drivers
 * can be compared with each other: SQLite reports the declared affinity
 * ("TEXT"), MySQL appends display widths and modifiers ("int(10) unsigned")
 * and Postgres reports multi word names ("double precision").
 */
function normalizeColumnType(type: unknown): string {
  const base = String(type ?? "").toLowerCase().split("(")[0] ?? "";
  return base.trim().split(/\s+/)[0] ?? "";
}

function isNumericColumnType(type: unknown): boolean {
  return NUMERIC_COLUMN_TYPES.has(normalizeColumnType(type));
}

/**
 * Whether a primary key column expects the application to supply its value.
 * Any non numeric primary key (uuid, char(36), TEXT under SQLite, ...) that is
 * not auto incrementing has to be filled in before inserting.
 */
export function shouldGeneratePrimaryKeyForColumn(
  column: { type?: unknown; primary?: boolean; autoIncrement?: boolean } | null | undefined
): boolean {
  if (!column) return false;
  if (!column.primary) return false;
  if (column.autoIncrement) return false;
  return !isNumericColumnType(column.type);
}
