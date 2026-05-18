import { expect, test, describe } from "bun:test";
import { Connection } from "../src/index.js";

describe("Connection", () => {
  test("creates connection from sqlite url", () => {
    const conn = new Connection({ url: "sqlite://:memory:" });
    expect(conn.getDriverName()).toBe("sqlite");
  });

  test("creates connection from mysql url", () => {
    const conn = new Connection({ url: "mysql://user:pass@localhost:3306/db" });
    expect(conn.getDriverName()).toBe("mysql");
  });

  test("creates connection from postgres url", () => {
    const conn = new Connection({ url: "postgres://user:pass@localhost:5432/db" });
    expect(conn.getDriverName()).toBe("postgres");
  });

  test("creates connection from driver config (sqlite)", () => {
    const conn = new Connection({ driver: "sqlite", filename: ":memory:" });
    expect(conn.getDriverName()).toBe("sqlite");
  });

  test("creates connection from driver config (mysql)", () => {
    const conn = new Connection({ driver: "mysql", host: "localhost", database: "db" });
    expect(conn.getDriverName()).toBe("mysql");
  });

  test("runs and queries sql", async () => {
    const conn = new Connection({ url: "sqlite://:memory:" });
    await conn.run("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
    await conn.run("INSERT INTO test (name) VALUES ('Alice')");
    const rows = await conn.query("SELECT * FROM test WHERE name = 'Alice'");
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Alice");
  });

  test("normalizes Date bindings to ISO strings", async () => {
    const calls: any[][] = [];
    const driver = {
      unsafe(_sql: string, bindings?: any[]) {
        calls.push(bindings ?? []);
        return [];
      },
    };
    const conn = new Connection({ url: "postgres://user:pass@localhost:5432/db" }, { driver: driver as any });
    const date = new Date("2026-05-17T00:00:00.000+08:00");

    await conn.query("SELECT $1", [date, [date]]);

    expect(calls[0]).toEqual([
      "2026-05-16T16:00:00.000Z",
      ["2026-05-16T16:00:00.000Z"],
    ]);
  });

  test("supports transactions", async () => {
    const conn = new Connection({ url: "sqlite://:memory:" });
    await conn.run("CREATE TABLE tx_test (id INTEGER PRIMARY KEY)");
    await conn.beginTransaction();
    await conn.run("INSERT INTO tx_test (id) VALUES (1)");
    await conn.rollback();
    const rows = await conn.query("SELECT * FROM tx_test");
    expect(rows).toHaveLength(0);
  });

  test("supports nested transactions with savepoints", async () => {
    const conn = new Connection({ url: "sqlite://:memory:" });
    await conn.run("CREATE TABLE nested_tx_test (id INTEGER PRIMARY KEY)");

    await conn.beginTransaction();
    await conn.run("INSERT INTO nested_tx_test (id) VALUES (1)");
    await conn.beginTransaction();
    await conn.run("INSERT INTO nested_tx_test (id) VALUES (2)");
    await conn.rollback();
    await conn.commit();

    const rows = await conn.query("SELECT * FROM nested_tx_test ORDER BY id");
    expect(rows.map((row) => row.id)).toEqual([1]);
  });

  test("opens a root transaction before nested savepoints on borrowed postgres connections", async () => {
    const calls: string[] = [];
    const reserved = {
      unsafe(sql: string) {
        calls.push(sql);
        return [];
      },
      release() {
        calls.push("RELEASE");
      },
    };
    const driver = {
      async reserve() {
        calls.push("RESERVE");
        return reserved;
      },
      unsafe(sql: string) {
        calls.push(sql);
        return [];
      },
    };
    const conn = new Connection({ url: "postgres://user:pass@localhost:5432/db" }, { driver: driver as any });

    await conn.transaction(async (tx) => {
      expect(tx.isInTransaction()).toBe(true);
      await tx.transaction(async () => {});
    });

    expect(calls).toEqual([
      "RESERVE",
      "BEGIN",
      "SAVEPOINT bunny_trans_1",
      "RELEASE SAVEPOINT bunny_trans_1",
      "COMMIT",
      "RELEASE",
    ]);
  });

  test("keeps driver.begin() callback connections on savepoints", async () => {
    const calls: string[] = [];
    const txDriver = {
      unsafe(sql: string) {
        calls.push(sql);
        return [];
      },
    };
    const driver = {
      async begin<T>(callback: (sql: any) => Promise<T> | T) {
        calls.push("BEGIN_BLOCK");
        return await callback(txDriver as any);
      },
    };
    const conn = new Connection({ url: "postgres://user:pass@localhost:5432/db" }, { driver: driver as any, ownsDriver: true });

    await conn.transaction(async (tx) => {
      expect(tx.isInTransaction()).toBe(true);
      await tx.beginTransaction();
      await tx.commit();
    });

    expect(calls).toEqual(["BEGIN_BLOCK", "SAVEPOINT bunny_trans_1", "RELEASE SAVEPOINT bunny_trans_1"]);
  });

  test("starts transactions directly on dedicated search_path connections", async () => {
    const calls: string[] = [];
    const reserved = {
      unsafe(sql: string) {
        calls.push(sql);
        return [];
      },
      release() {
        calls.push("RELEASE");
      },
    };
    const driver = {
      async reserve() {
        calls.push("RESERVE");
        return reserved;
      },
    };
    const conn = new Connection({ url: "postgres://user:pass@localhost:5432/db" }, { driver: driver as any, ownsDriver: true });

    await conn.withSearchPath("tenant_demo", async (tenantConnection) => {
      await tenantConnection.transaction(async () => {});
    });

    expect(calls).toEqual([
      "RESERVE",
      `SET search_path TO "tenant_demo"`,
      "BEGIN",
      "COMMIT",
      "RESET search_path",
      "RELEASE",
    ]);
  });

  test("rejects unsafe PostgreSQL tenant setting names", async () => {
    const conn = new Connection({ url: "postgres://user:pass@localhost:5432/db" });

    await expect(
      conn.withTenant("tenant-1", async () => {}, "app.tenant_id; RESET search_path; --")
    ).rejects.toThrow("Invalid PostgreSQL setting name");
  });
});
