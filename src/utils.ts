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

export function isNumericColumnType(type: unknown): boolean {
  return NUMERIC_COLUMN_TYPES.has(normalizeColumnType(type));
}

/** Length of the UUID strings `crypto.randomUUID()` produces. */
const UUID_LENGTH = 36;

/**
 * The length a column declares, when it declares one: "char(64)" -> 64. Drivers
 * that report the length separately (Postgres reports "character" plus
 * `character_maximum_length`) pass it through `column.length` instead.
 */
export function declaredColumnLength(type: unknown): number | null {
  const match = /\(\s*(\d+)/.exec(String(type ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * Whether the ORM should generate a UUID for this primary key.
 *
 * Being non numeric is not enough on its own. A column with a database default
 * already has its value decided, and a column too short to hold a UUID (a
 * CHAR(26) holding ULIDs, say) would be corrupted by one — in both cases the
 * value belongs to the database or the application, not to us. Models that want
 * UUIDs regardless say so with `usesUuids` / `keyType = "uuid"`, which is
 * checked before this ever runs.
 */
export function shouldGeneratePrimaryKeyForColumn(
  column:
    | { type?: unknown; primary?: boolean; autoIncrement?: boolean; default?: unknown; length?: number | null }
    | null
    | undefined
): boolean {
  if (!column) return false;
  if (!column.primary) return false;
  if (column.autoIncrement) return false;
  if (column.default !== undefined && column.default !== null) return false;
  if (isNumericColumnType(column.type)) return false;

  const length = column.length ?? declaredColumnLength(column.type);
  return length === null || length >= UUID_LENGTH;
}
