import { describe, expect, test } from "bun:test";
import { Builder, Connection, Model } from "../src/index.js";
import { formatDateForDriver } from "../src/utils.js";
import { setupTestDb } from "./helpers.js";

describe("Date handling", () => {
  test("a Date and its ISO equivalent are the same value for dirty tracking", async () => {
    const connection = setupTestDb();
    const { Schema } = await import("../src/index.js");
    await Schema.create("beats", (table) => {
      table.increments("id");
      table.string("at");
    });

    class Beat extends Model {
      static override table = "beats";
      static override casts = { at: "datetime" };
      static override fillable = ["at"];
      static override timestamps = false;
    }

    const instant = new Date("2026-08-19T14:00:00.123Z");
    const beat = await Beat.create({ at: instant } as any);
    expect(typeof (beat as any).$attributes.at).toBe("string");

    // Same moment, different object: nothing changed.
    (beat as any).at = new Date(instant.getTime());
    expect(beat.isDirty()).toBe(false);

    // And the ISO string it is stored as counts as the same value too.
    (beat as any).at = instant.toISOString();
    expect(beat.isDirty()).toBe(false);

    (beat as any).at = new Date("2026-08-19T15:00:00.000Z");
    expect(beat.isDirty()).toBe(true);
  });

  test("a Date bound into a query is rendered for the driver", async () => {
    const rendered: string[] = [];
    const driver = { unsafe: (_sql: string, bindings?: any[]) => (rendered.push(...(bindings ?? [])), []) };

    for (const [url, expected] of [
      ["sqlite://:memory:", "2026-08-19T14:00:00.123Z"],
      ["mysql://user:pass@localhost:3306/db", "2026-08-19 14:00:00.123"],
      ["postgres://user:pass@localhost:5432/db", "2026-08-19T14:00:00.123Z"],
    ] as const) {
      rendered.length = 0;
      const connection = new Connection({ url }, { driver: driver as any, ownsDriver: false });
      await connection.query("SELECT ?", [new Date("2026-08-19T14:00:00.123Z")]);
      expect(rendered[0]).toBe(expected);
    }
  });

  test("MySQL checks and executes a date query on the same reserved session", async () => {
    const calls: string[] = [];
    let released = false;
    const reserved = {
      unsafe: async (sql: string) => {
        calls.push(`reserved:${sql}`);
        return sql.startsWith("SELECT TIMESTAMPDIFF") ? [{ offset_seconds: 0 }] : [];
      },
      release: () => { released = true; },
    };
    const pool = {
      unsafe: async (sql: string) => { calls.push(`pool:${sql}`); return []; },
      reserve: async () => reserved,
    };
    const connection = new Connection(
      { url: "mysql://user:pass@localhost:3306/db" },
      { driver: pool as any, ownsDriver: false }
    );

    await connection.run("SELECT ?", [new Date("2026-08-19T14:00:00.123Z")]);

    expect(calls).toEqual([
      "reserved:SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS offset_seconds",
      "reserved:SELECT ?",
    ]);
    expect(released).toBe(true);
  });

  test("formatDateForDriver keeps milliseconds and drops the T only for MySQL", () => {
    const instant = new Date("2026-08-19T14:00:00.123Z");
    expect(formatDateForDriver(instant, "mysql")).toBe("2026-08-19 14:00:00.123");
    expect(formatDateForDriver(instant, "sqlite")).toBe("2026-08-19T14:00:00.123Z");
    expect(formatDateForDriver(instant, "postgres")).toBe("2026-08-19T14:00:00.123Z");
    expect(formatDateForDriver(instant, undefined)).toBe("2026-08-19T14:00:00.123Z");
  });

  test("a model with a date cast needs no connection to exist", () => {
    class Detached extends Model {
      static override table = "detached";
      static override casts = { when: "datetime" };
      static override fillable = ["when"];
    }
    const detached = new Detached({ when: new Date("2026-08-19T14:00:00.123Z") } as any);
    expect((detached as any).$attributes.when).toBe("2026-08-19T14:00:00.123Z");
  });
});
