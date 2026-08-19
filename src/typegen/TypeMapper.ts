export class TypeMapper {
  static sqlToTsType(
    sqlType: string,
    nullable: boolean,
    driver?: "sqlite" | "mysql" | "postgres",
    bigint = false
  ): string {
    const base = this.mapBaseType(sqlType, driver, bigint);
    return nullable && base !== "any" ? `${base} | null` : base;
  }

  private static mapBaseType(
    sqlType: string,
    driver?: "sqlite" | "mysql" | "postgres",
    bigint = false
  ): string {
    const t = sqlType.toLowerCase();

    // Bun's MySQL driver preserves exact BIGINT/DECIMAL values instead of
    // forcing them through an unsafe JavaScript number. DATE-family columns
    // and native JSON are decoded as objects by the driver.
    if (driver === "mysql") {
      if (/\bjson\b/.test(t)) return "any";
      if (/^bigint\b/.test(t)) return bigint ? "number | bigint" : "number | string";
      if (/^(decimal|numeric)\b/.test(t)) return "string";
      if (/^(date|datetime|timestamp)\b/.test(t)) return "Date";
      if (/^time\b/.test(t)) return "string";
      if (/^(tinyint|smallint|mediumint|int|integer)\b/.test(t)) return "number";
    }

    if (driver === "postgres") {
      if (/\bjsonb?\b/.test(t)) return "any";
      if (/^(bigint|int8)\b/.test(t)) return bigint ? "bigint" : "string";
      if (/^(decimal|numeric)\b/.test(t)) return "string";
      if (/^(date|timestamp)/.test(t)) return "Date";
      if (/^time\b/.test(t)) return "string";
      if (/^(smallint|integer|int2|int4|real|double precision)\b/.test(t)) return "number";
      if (/^boolean\b/.test(t)) return "boolean";
    }

    // Integers & numbers
    if (/int|serial|float|double|real|decimal|numeric/.test(t)) {
      return "number";
    }

    // Boolean
    if (/bool/.test(t)) {
      return "boolean";
    }

    // JSON
    if (/json/.test(t)) {
      return "any";
    }

    // Binary / BLOB
    if (/blob|bytea|binary|varbinary/.test(t)) {
      return "Buffer";
    }

    // Default to string for everything else (varchar, text, char, date, enum, uuid, etc.)
    return "string";
  }
}
