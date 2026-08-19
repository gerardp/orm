import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { pathToFileURL } from "url";
import { Builder, Connection, Migrator, Model, Schema } from "../src/index.js";
import { createDriverContext, serverUrl, type ServerDriver } from "./driver-harness.js";

type ContractDriver = "sqlite" | ServerDriver;

interface ContractContext {
  connection: Connection;
  dispose(): Promise<void>;
}

class ContractUser extends Model {
  static table = "contract_users";
  static timestamps = false;

  posts() {
    return this.hasMany(ContractPost, "user_id");
  }
}

class ContractPost extends Model {
  static table = "contract_posts";
  static timestamps = false;

  user() {
    return this.belongsTo(ContractUser, "user_id");
  }
}

async function createContext(driver: ContractDriver): Promise<ContractContext> {
  if (driver !== "sqlite") return await createDriverContext(driver);
  const connection = new Connection({ url: "sqlite://:memory:" });
  Model.setConnection(connection);
  Schema.setConnection(connection);
  return { connection, dispose: () => connection.close() };
}

for (const driver of ["sqlite", "mysql", "postgres"] as const) {
  const run = driver === "sqlite" || serverUrl(driver) ? test.serial : test.skip;

  describe.serial(`${driver} driver contract`, () => {
    let context: ContractContext;

    beforeAll(async () => {
      if (driver !== "sqlite" && !serverUrl(driver)) return;
      context = await createContext(driver);
    });

    afterAll(async () => {
      await context?.dispose();
    });

    run("supports schema changes, CRUD, relations, dates, JSON, upserts, and transactions", async () => {
      const connection = context.connection;

      await Schema.create("contract_users", (table) => {
        table.increments("id");
        table.string("email").unique();
        table.string("name");
        table.json("tags");
        table.timestamp("joined_at");
      }, connection);
      await Schema.create("contract_posts", (table) => {
        table.increments("id");
        table.integer("user_id").unsigned().index();
        table.string("title");
        table.foreign("user_id").references("id").on("contract_users").cascadeOnDelete();
      }, connection);

      await Schema.table("contract_users", (table) => {
        table.string("nickname").nullable();
      }, connection);
      await Schema.table("contract_users", (table) => {
        table.renameColumn("nickname", "display_name");
      }, connection);

      expect(await Schema.hasColumn("contract_users", "display_name", connection)).toBe(true);
      expect(await Schema.hasIndex("contract_posts", ["user_id"])).toBe(true);
      expect(await Schema.hasForeignKey("contract_posts", ["user_id"])).toBe(true);

      const joinedAt = new Date("2026-08-19T10:11:12.345Z");
      const user = await ContractUser.create({
        email: "ada@example.test",
        name: "Ada",
        tags: JSON.stringify(["bun", "orm"]),
        joined_at: joinedAt,
      });
      const post = await ContractPost.create({ user_id: user.getAttribute("id"), title: "First" });

      expect((await ContractUser.find(user.getAttribute("id")))?.getAttribute("name")).toBe("Ada");
      expect((await user.posts().get()).map((row) => row.getAttribute("title"))).toEqual(["First"]);
      expect((await post.user().get())?.getAttribute("email")).toBe("ada@example.test");
      expect(await ContractUser.whereDate("joined_at", "2026-08-19").count()).toBe(1);
      expect(await ContractUser.whereJsonContains("tags", "orm").count()).toBe(1);

      await new Builder(connection, "contract_users").insertOrIgnore({
        email: "ada@example.test",
        name: "Ignored",
        tags: "[]",
        joined_at: joinedAt,
      });
      expect(await ContractUser.where("email", "ada@example.test").count()).toBe(1);

      await new Builder(connection, "contract_users").upsert({
        email: "ada@example.test",
        name: "Ada Updated",
        tags: JSON.stringify(["orm"]),
        joined_at: joinedAt,
      }, "email", ["name", "tags"]);
      expect((await ContractUser.where("email", "ada@example.test").first())?.getAttribute("name")).toBe("Ada Updated");

      await expect(connection.transaction(async (transaction) => {
        await new Builder(transaction, "contract_users").insert({
          email: "rollback@example.test",
          name: "Rollback",
          tags: "[]",
          joined_at: joinedAt,
        });
        throw new Error("rollback contract");
      })).rejects.toThrow("rollback contract");
      expect(await ContractUser.where("email", "rollback@example.test").count()).toBe(0);

      user.setAttribute("name", "Saved");
      await user.save();
      expect((await ContractUser.find(user.getAttribute("id")))?.getAttribute("name")).toBe("Saved");
      await post.delete();
      expect(await ContractPost.find(post.getAttribute("id"))).toBeNull();
    });

    run("keeps raw and nested query values out of SQL text", async () => {
      const connection = context.connection;
      const malicious = "CURRENT_TIMESTAMP OR 1=1 --";

      const nested = new Builder(connection, "contract_users").where("name", malicious);
      expect(await new Builder(connection, "contract_users").fromSub(nested, "filtered").count()).toBe(0);

      const selected = await new Builder(connection, "contract_users")
        .selectRaw("? AS marker", [malicious])
        .whereRaw("name = ?", ["Saved"])
        .first();
      expect((selected as any)?.marker).toBe(malicious);

      expect(() => new Builder(connection, "contract_users").where("name", "= ? OR 1=1 --", "missing")).toThrow("Invalid query operator");
    });

    run("runs and rolls back migrations", async () => {
      const migrations = await mkdtemp(join(process.cwd(), "tests", ".tmp-driver-contract-"));
      const ormUrl = pathToFileURL(join(process.cwd(), "src", "index.ts")).href;
      const migrationPath = join(migrations, "20260819000000_create_contract_migrated.ts");
      await Bun.write(migrationPath, `
import { Migration, Schema } from ${JSON.stringify(ormUrl)};
export default class CreateContractMigrated extends Migration {
  async up() {
    await Schema.create("contract_migrated", (table) => {
      table.increments("id");
      table.string("value");
    });
  }
  async down() {
    await Schema.dropIfExists("contract_migrated");
  }
}
`);

      try {
        const migrator = new Migrator(context.connection, migrations);
        await migrator.run();
        expect(await Schema.hasTable("contract_migrated", context.connection)).toBe(true);
        expect((await migrator.status())[0]?.status).toBe("Ran");
        await migrator.rollback();
        expect(await Schema.hasTable("contract_migrated", context.connection)).toBe(false);
      } finally {
        await rm(migrations, { recursive: true, force: true });
      }
    });
  });
}
