import { expect, test, describe, beforeAll } from "bun:test";
import { Model, Schema, Factory, Sequence } from "../src/index.js";
import { PermissiveModel, setupTestDb } from "./helpers.js";

class FUser extends PermissiveModel {
  static table = "f_users";
  posts() {
    return this.hasMany(FPost);
  }
}

class FPost extends PermissiveModel {
  static table = "f_posts";
  fuser() {
    return this.belongsTo(FUser);
  }
}

// Class-based factories — model carries no factory code.
class FUserFactory extends Factory<FUser> {
  definition(seq: number) {
    return { name: `User ${seq}`, email: `user${seq}@test.com`, role: "member", active: true };
  }
  admin() {
    return this.state({ role: "admin" });
  }
  inactive() {
    return this.state((_a, seq) => ({ active: false, name: `Inactive ${seq}` }));
  }
}

class FPostFactory extends Factory<FPost> {
  definition(seq: number) {
    return { title: `Post ${seq}` };
  }
}

Factory.register(FUser, FUserFactory);
Factory.register(FPost, FPostFactory);

describe("Factory (class-based, Laravel parity)", () => {
  beforeAll(async () => {
    setupTestDb();
    await Schema.create("f_users", (t) => {
      t.increments("id");
      t.string("name");
      t.string("email");
      t.string("role");
      t.boolean("active");
      t.timestamps();
    });
    await Schema.create("f_posts", (t) => {
      t.increments("id");
      t.integer("f_user_id");
      t.string("title");
      t.timestamps();
    });
  });

  test("Model.factory() resolves the registered factory class", () => {
    expect(FUser.factory()).toBeInstanceOf(FUserFactory);
  });

  test("make() builds unsaved instance with sequence", () => {
    const u = FUser.factory().make() as FUser;
    expect(u).toBeInstanceOf(FUser);
    expect(u.getAttribute("name")).toBe("User 1");
    expect(u.getAttribute("id")).toBeUndefined();
  });

  test("count() returns array; single returns scalar", () => {
    expect(Array.isArray(FUser.factory().make())).toBe(false);
    const many = FUser.factory().count(3).make() as FUser[];
    expect(many.map((m) => m.getAttribute("name"))).toEqual(["User 1", "User 2", "User 3"]);
  });

  test("create() persists; raw() returns attributes only", async () => {
    const created = (await FUser.factory().create()) as FUser;
    expect(created.getAttribute("id")).toBeDefined();
    expect(await FUser.where("email", "user1@test.com").first()).not.toBeNull();

    const raw = FUser.factory().raw() as any;
    expect(raw).toEqual({ name: "User 1", email: "user1@test.com", role: "member", active: true });
  });

  test("state methods on the factory class", async () => {
    const admin = (await FUser.factory().admin().create()) as FUser;
    expect(admin.getAttribute("role")).toBe("admin");

    const inactive = FUser.factory().inactive().make() as FUser;
    expect(inactive.getAttribute("active")).toBe(false);
    expect(inactive.getAttribute("name")).toBe("Inactive 1");
  });

  test("precedence: definition -> state -> override", () => {
    const u = FUser.factory().admin().make({ role: "owner" }) as FUser;
    expect(u.getAttribute("role")).toBe("owner");
  });

  test("Sequence cycles patches across count()", () => {
    const users = FUser.factory()
      .count(4)
      .state(new Sequence({ role: "a" }, { role: "b" }))
      .make() as FUser[];
    expect(users.map((u) => u.getAttribute("role"))).toEqual(["a", "b", "a", "b"]);
  });

  test("afterMaking / afterCreating hooks run per model", async () => {
    const made: number[] = [];
    const createdNames: string[] = [];
    const f = FUser.factory()
      .count(2)
      .afterMaking((_m, seq) => { made.push(seq); })
      .afterCreating((m) => { createdNames.push(m.getAttribute("name")); });

    f.make();
    expect(made).toEqual([1, 2]);
    made.length = 0;
    await f.create();
    expect(made).toEqual([1, 2]);
    expect(createdNames).toEqual(["User 1", "User 2"]);
  });

  test(".for() sets belongsTo FK from a parent model", async () => {
    const parent = (await FUser.factory().create()) as FUser;
    const post = (await FPost.factory().for(parent, "fuser").create()) as FPost;
    expect(post.getAttribute("f_user_id")).toBe(parent.getAttribute("id"));
  });

  test(".for() accepts a parent Factory (created lazily)", async () => {
    const post = (await FPost.factory().for(FUser.factory(), "fuser").create()) as FPost;
    const owner = await FUser.find(post.getAttribute("f_user_id"));
    expect(owner).not.toBeNull();
  });

  test(".has() creates related children through hasMany", async () => {
    const user = (await FUser.factory()
      .has(FPost.factory().count(3), "posts")
      .create()) as FUser;
    const posts = await FPost.where("f_user_id", user.getAttribute("id")).get();
    expect(posts).toHaveLength(3);
  });

  test("unregistered model.factory() throws a clear error", () => {
    class Orphan extends PermissiveModel {
      static table = "orphans";
    }
    expect(() => (Orphan as any).factory()).toThrow("No factory registered for Orphan");
  });

  test("immutability: chained builders return new factories, base untouched", () => {
    const base = FUser.factory();
    const derived = base.count(5).admin();
    expect((base.make() as FUser).getAttribute("role")).toBe("member");
    expect(Array.isArray(base.make())).toBe(false);
    expect(derived.make()).toHaveLength(5);
    expect((derived.make() as FUser[])[0].getAttribute("role")).toBe("admin");
  });

  test("chained state methods compose (admin + inactive)", () => {
    const u = FUser.factory().admin().inactive().make() as FUser;
    expect(u.getAttribute("role")).toBe("admin");
    expect(u.getAttribute("active")).toBe(false);
  });
});
