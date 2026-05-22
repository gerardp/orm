import { describe, expect, test } from "bun:test";
import { Validator } from "../src/validation/index.js";

describe("validation safeParse result shapes", () => {
  test("Validator.safeParse returns an error bag while schema.safeParse returns standard issues", async () => {
    const entries = {
      email: Validator.required().email(),
    };

    const legacyResult = await Validator.safeParse(entries, { email: "not-an-email" });
    expect(legacyResult.success).toBe(false);
    if (!legacyResult.success) {
      expect(Array.isArray(legacyResult.issues)).toBe(false);
      expect(legacyResult.issues).toEqual({
        email: ["The email field must be a valid email address."],
      });
    }

    const schema = Validator.schema(entries);
    const standardResult = await schema.safeParse({ email: "not-an-email" });
    expect(standardResult.success).toBe(false);
    if (!standardResult.success) {
      expect(Array.isArray(standardResult.issues)).toBe(true);
      expect(standardResult.issues).toEqual([
        {
          message: "The email field must be a valid email address.",
          path: [{ key: "email" }],
        },
      ]);
    }
  });
});
