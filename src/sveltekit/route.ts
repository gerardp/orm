import type { ModelConstructor } from "../model/Model.js";
import type { RequestEvent, ServerLoadEvent } from "@sveltejs/kit";
import { Validator } from "../validation/Validator.js";
import type { ValidationObjectSchema } from "../validation/Validator.js";
import type { InferOutput, ValidationSchema } from "../validation/Rule.js";

type RequestEventLike = {
  params: Record<string, string | undefined>;
  request: Request;
};

type UnwrapModel<M extends ModelConstructor<any>> = InstanceType<M>;
type DefaultAliasFor<M extends ModelConstructor<any>> = Uncapitalize<M["name"]>;

type BindingsMap = Record<string, unknown>;

type SchemaOutput<S> =
  S extends ValidationObjectSchema<infer Entries extends ValidationSchema> ? InferOutput<Entries> :
  S extends ValidationSchema ? InferOutput<S> :
  unknown;

type HandlerContext<TBindings extends BindingsMap, TData> = TBindings & { data: TData };
type RouteHandler<TEvent, TBindings extends BindingsMap, TData, TResult> =
  (event: TEvent, context: HandlerContext<TBindings, TData>) => TResult | Promise<TResult>;

type BindSpec = {
  alias: string;
  param: string;
  model: ModelConstructor<any>;
};

let svelteKitErrorFactory: ((status: number, body: string) => unknown) | null = null;
let svelteKitDependencyChecked = false;
let svelteKitModuleResolved = false;

function assertSvelteKitDependency(): void {
  if (svelteKitModuleResolved) return;
  try {
    import.meta.resolve("@sveltejs/kit");
    svelteKitModuleResolved = true;
  } catch {
    throw new Error(
      'Missing dependency "@sveltejs/kit". Install it with `bun add @sveltejs/kit` (or npm/pnpm/yarn equivalent) to use @bunnykit/orm/sveltekit route().',
    );
  }
}

async function ensureSvelteKitDependency(): Promise<void> {
  assertSvelteKitDependency();
  if (svelteKitDependencyChecked) return;
  try {
    const mod = await import("@sveltejs/kit");
    svelteKitErrorFactory = mod.error;
    svelteKitDependencyChecked = true;
  } catch {
    // The module was resolved synchronously in route(); this fallback only
    // catches unexpected runtime loader failures.
    throw new Error('Failed to import "@sveltejs/kit" at runtime.');
  }
}

async function throwBindError(param: string, value: string): Promise<never> {
  await ensureSvelteKitDependency();
  const message = value
    ? `No record found for route param "${param}" with value "${value}".`
    : `Missing route param "${param}".`;
  if (svelteKitErrorFactory) {
    throw svelteKitErrorFactory(404, message);
  }
  throw new Error(message);
}

function defaultAliasForModel(model: ModelConstructor<any>): string {
  const name = model.name || "model";
  return name.length === 0 ? "model" : name[0].toLowerCase() + name.slice(1);
}

class RouteBuilder<
  TBindings extends BindingsMap = {},
  TSchema = undefined,
> {
  private readonly bindings: BindSpec[];
  private readonly schemaDef?: ValidationSchema | ValidationObjectSchema<any>;

  constructor(
    bindings: BindSpec[] = [],
    schemaDef?: ValidationSchema | ValidationObjectSchema<any>,
  ) {
    this.bindings = bindings;
    this.schemaDef = schemaDef;
  }

  bind<TModel extends ModelConstructor<any>>(
    model: TModel,
  ): RouteBuilder<TBindings & Record<DefaultAliasFor<TModel>, UnwrapModel<TModel>>, TSchema>;
  bind<TModel extends ModelConstructor<any>, TParam extends string>(
    model: TModel,
    param: TParam,
  ): RouteBuilder<TBindings & Record<DefaultAliasFor<TModel>, UnwrapModel<TModel>>, TSchema>;
  bind<TModel extends ModelConstructor<any>, TParam extends string, TAlias extends string>(
    model: TModel,
    param: TParam,
    alias: TAlias,
  ): RouteBuilder<TBindings & Record<TAlias, UnwrapModel<TModel>>, TSchema>;
  bind<
    TModel extends ModelConstructor<any>,
    TParam extends string = "id",
    TAlias extends string = DefaultAliasFor<TModel>,
  >(
    model: TModel,
    param?: TParam,
    alias?: TAlias,
  ): RouteBuilder<TBindings & Record<TAlias, UnwrapModel<TModel>>, TSchema> {
    const resolvedParam = (param ?? "id") as string;
    const resolvedAlias = (alias ?? defaultAliasForModel(model)) as string;
    return new RouteBuilder(
      [...this.bindings, { model, param: resolvedParam, alias: resolvedAlias }],
      this.schemaDef,
    ) as any;
  }

  schema<S extends ValidationSchema | ValidationObjectSchema<any>>(
    schema: S,
  ): RouteBuilder<TBindings, S> {
    return new RouteBuilder(this.bindings, schema) as any;
  }

  private async resolveBindings(event: RequestEventLike): Promise<TBindings> {
    const context: Record<string, unknown> = {};
    for (const binding of this.bindings) {
      const raw = event.params?.[binding.param];
      if (!raw) {
        await throwBindError(binding.param, "");
      }
      const paramValue = raw as string;
      let record: unknown;
      try {
        record = await (binding.model as any).findOrFail(paramValue);
      } catch {
        await throwBindError(binding.param, paramValue);
      }
      context[binding.alias] = record;
    }
    return context as TBindings;
  }

  action<TResult>(
    handler: RouteHandler<RequestEvent, TBindings, TSchema extends undefined ? undefined : SchemaOutput<TSchema>, TResult>,
  ): (event: RequestEvent) => Promise<TResult> {
    return async (event: RequestEvent): Promise<TResult> => {
      const bound = await this.resolveBindings(event);
      const data = this.schemaDef
        ? await Validator.parse(this.schemaDef as any, event.request)
        : undefined;

      return await handler(event, {
        ...bound,
        data: data as any,
      });
    };
  }

  load<TResult extends Record<string, any> | void>(
    handler: RouteHandler<ServerLoadEvent, TBindings, undefined, TResult>,
  ): (event: ServerLoadEvent) => Promise<TResult> {
    return async (event: ServerLoadEvent): Promise<TResult> => {
      const bound = await this.resolveBindings(event);
      return await handler(event, {
        ...bound,
        data: undefined as undefined,
      });
    };
  }

  handle<TResult>(
    handler: RouteHandler<RequestEvent, TBindings, TSchema extends undefined ? undefined : SchemaOutput<TSchema>, TResult>,
  ): (event: RequestEvent) => Promise<TResult> {
    return this.action(handler);
  }
}

export function route(): RouteBuilder<{}, undefined> {
  assertSvelteKitDependency();
  return new RouteBuilder<{}, undefined>();
}

export type { RequestEventLike, HandlerContext };
