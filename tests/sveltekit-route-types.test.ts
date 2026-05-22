import { describe, it, expect } from "bun:test";
import type { Actions, PageServerLoad, RequestEvent, ServerLoadEvent } from "@sveltejs/kit";
import { Model } from "../src/model/Model.js";
import { route } from "../src/sveltekit/index.js";
import { Validator, rule } from "../src/validation/index.js";
function expectType<T>(_v: T): void {}

class Branch extends Model.define("branches") {}
class Payroll extends Model.define("payrolls") {}
class AcademicYear extends Model.define("academic_years") {}

const PostSchema = Validator.schema({
  title: rule().required().string(),
});

describe("sveltekit route() typing", () => {
  it("is compatible with PageServerLoad and supports aliases", () => {
    const load: PageServerLoad = route()
      .bind(Branch)
      .bind(Payroll, "payroll_id")
      .bind(AcademicYear, "academic_year")
      .bind(Branch, "source_branch_id", "sourceBranch")
      .load(async (_event, { branch, payroll, academicYear, sourceBranch, data }) => {
        expectType<ServerLoadEvent>(_event);
        expectType<Branch>(branch);
        expectType<Payroll>(payroll);
        expectType<AcademicYear>(academicYear);
        expectType<Branch>(sourceBranch);
        expectType<undefined>(data);
        expect(branch).toBeDefined();
        expect(payroll).toBeDefined();
        expect(academicYear).toBeDefined();
        expect(sourceBranch).toBeDefined();
        expect(data).toBeUndefined();
        return { ok: true };
      });

    expect(typeof load).toBe("function");
  });

  it("builds SvelteKit-compatible actions object", () => {
    const formActions: Actions = {
      create: route()
        .bind(Branch)
        .schema(PostSchema)
        .action(async (_event, { branch, data }) => {
          expectType<RequestEvent>(_event);
          expectType<Branch>(branch);
          expectType<{ title: string }>(data);
          expect(branch).toBeDefined();
          expect(data.title).toBeDefined();
          return { ok: true };
        }),
      update: route()
        .bind(Payroll, "payroll_id")
        .action(async (_event, { payroll }) => {
          expectType<Payroll>(payroll);
          return { id: payroll.id as any };
        }),
    };

    expect(typeof formActions.create).toBe("function");
    expect(typeof formActions.update).toBe("function");
  });

  it("supports typed duplicate model binding with explicit alias", () => {
    const load: PageServerLoad = route()
      .bind(Branch, "id", "originBranch")
      .bind(Branch, "target_id", "targetBranch")
      .load(async (_event, { originBranch, targetBranch }) => {
        expectType<Branch>(originBranch);
        expectType<Branch>(targetBranch);
        return { ok: true };
      });
    expect(typeof load).toBe("function");
  });
});
