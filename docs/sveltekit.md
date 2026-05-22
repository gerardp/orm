# SvelteKit Helper

Use the SvelteKit helper to bind route params to Bunny models and (for actions) validate incoming form/request data.

Import:

```ts
import { route } from "@bunnykit/orm/sveltekit";
```

## `load` example (`+page.server.ts`)

`load` uses model binding from `event.params`. It does not run schema validation.

```ts
import type { PageServerLoad } from "./$types";
import { route } from "@bunnykit/orm/sveltekit";
import Branch from "$lib/server/models/Branch";
import Payroll from "$lib/server/models/Payroll";

export const load: PageServerLoad = route()
  .bind(Branch) // binds params.id -> context.branch
  .bind(Payroll, "payroll_id") // binds params.payroll_id -> context.payroll
  .bind(Branch, "source_branch_id", "sourceBranch") // same model, custom alias
  .load(async (event, { branch, payroll, sourceBranch, data }) => {
    // event is ServerLoadEvent
    // data is always undefined in load()
    return {
      branch,
      payroll,
      sourceBranch,
    };
  });
```

## `actions` example (`+page.server.ts`)

`action` uses model binding from `event.params` and schema validation from `event.request`.

```ts
import type { Actions } from "./$types";
import { route } from "@bunnykit/orm/sveltekit";
import { Validator, rule } from "@bunnykit/orm/validation";
import Branch from "$lib/server/models/Branch";

const PostSchema = Validator.schema({
  title: rule().required().string(),
});

export const actions: Actions = {
  create: route()
    .bind(Branch)
    .schema(PostSchema)
    .action(async (event, { branch, data }) => {
      // event is RequestEvent
      // data is typed from PostSchema => { title: string }
      await branch.update({ last_post_title: data.title });
      return { ok: true };
    }),
};
```

## Binding API

- `.bind(Model)` => binds from `params.id`, alias defaults to model name (e.g. `AcademicYear` -> `academicYear`)
- `.bind(Model, "param_name")` => binds from a custom route param
- `.bind(Model, "param_name", "alias")` => custom alias (useful when binding the same model twice)

If a param is missing or no record is found, the helper throws a SvelteKit 404 error.
