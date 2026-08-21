import { test } from "bun:test";
import { Blueprint } from "../src/schema/Blueprint.js";

test("timestamps exposes zero-argument and two-argument forms", () => {
  const table = new Blueprint("timestamps_types");
  table.timestamps();
  table.timestamps("createdAt", "updatedAt");

  if (false) {
    // @ts-expect-error timestamps requires either zero or two names.
    table.timestamps("createdAt");
    // @ts-expect-error timestamps does not accept three names.
    table.timestamps("createdAt", "updatedAt", "deletedAt");
  }

  expectType<void>(table.timestamps());
});

function expectType<T>(_value: T): void {}
