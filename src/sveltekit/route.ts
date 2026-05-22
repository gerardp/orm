import type { ModelConstructor } from "../model/Model.js";
import type { RequestEvent, ServerLoadEvent } from "@sveltejs/kit";
import { error, fail } from "@sveltejs/kit";
import type { ExtractStringPaths, StrictTypedEagerLoad, WithLoadedRelations } from "../model/Model.js";
import { Validator } from "../validation/Validator.js";
import type { ValidationObjectSchema } from "../validation/Validator.js";
import type { InferOutput, ValidationSchema } from "../validation/Rule.js";

type RequestEventLike = {
  params: Record<string, string | undefined>;
  request: Request;
};

type UnwrapModel<M extends ModelConstructor<any>> = InstanceType<M>;
type DefaultAliasFor<M extends ModelConstructor<any>> = Uncapitalize<M["name"]>;
type BindWithArg<M extends ModelConstructor<any>> =
  StrictTypedEagerLoad<InstanceType<M>> | readonly StrictTypedEagerLoad<InstanceType<M>>[];
type BindWithPaths<W> = W extends readonly any[] ? ExtractStringPaths<W[number]> : ExtractStringPaths<W>;
type BoundModel<M extends ModelConstructor<any>, W> =
  [W] extends [undefined]
    ? InstanceType<M>
    : WithLoadedRelations<InstanceType<M>, BindWithPaths<W>>;

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
  with?: unknown;
};
type BindOptions<M extends ModelConstructor<any>> = { with?: BindWithArg<M> };
type KitErrorFn = (status: number, body: { message: string }) => never;
type KitFailFn = (status: number, body: Record<string, unknown>) => unknown;
type RouteKitHelpers = {
  error?: KitErrorFn;
  fail?: KitFailFn;
};
type BindFailureReason = "missing_param" | "invalid_uuid" | "not_found";

async function requestValues(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = await request.clone().json();
      if (json && typeof json === "object" && !Array.isArray(json)) {
        return json as Record<string, unknown>;
      }
    } catch {
      // no-op; fall through to empty object
    }
    return {};
  }

  try {
    const formData = await request.clone().formData();
    const values: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        const existing = values[key];
        values[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        values[key] = value;
      }
    }
    return values;
  } catch {
    return {};
  }
}

function bindError(
  throwError: KitErrorFn,
  model: ModelConstructor<any>,
  alias: string,
  param: string,
  value: string,
  reason: BindFailureReason,
): never {
  const message = reason === "missing_param"
    ? "No record found."
    : reason === "invalid_uuid"
      ? "No record found."
      : "No record found.";
  return throwError(404, { message });
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isInvalidUuidInputError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (e.code === "22P02") return true;
  const message = typeof e.message === "string" ? e.message : "";
  return message.toLowerCase().includes("invalid input syntax for type uuid");
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
  private readonly throwError: KitErrorFn;
  private readonly makeFail: KitFailFn;

  constructor(
    bindings: BindSpec[] = [],
    schemaDef?: ValidationSchema | ValidationObjectSchema<any>,
    helpers: RouteKitHelpers = {},
  ) {
    this.bindings = bindings;
    this.schemaDef = schemaDef;
    this.throwError = helpers.error ?? error;
    this.makeFail = helpers.fail ?? fail;
  }

  bind<TModel extends ModelConstructor<any>>(
    model: TModel,
  ): RouteBuilder<TBindings & Record<DefaultAliasFor<TModel>, UnwrapModel<TModel>>, TSchema>;
  bind<TModel extends ModelConstructor<any>, TWith extends BindWithArg<TModel>>(
    model: TModel,
    options: { with: TWith },
  ): RouteBuilder<TBindings & Record<DefaultAliasFor<TModel>, BoundModel<TModel, TWith>>, TSchema>;
  bind<TModel extends ModelConstructor<any>, TParam extends string>(
    model: TModel,
    param: TParam,
  ): RouteBuilder<TBindings & Record<DefaultAliasFor<TModel>, UnwrapModel<TModel>>, TSchema>;
  bind<TModel extends ModelConstructor<any>, TParam extends string, TWith extends BindWithArg<TModel>>(
    model: TModel,
    param: TParam,
    options: { with: TWith },
  ): RouteBuilder<TBindings & Record<DefaultAliasFor<TModel>, BoundModel<TModel, TWith>>, TSchema>;
  bind<TModel extends ModelConstructor<any>, TParam extends string, TAlias extends string>(
    model: TModel,
    param: TParam,
    alias: TAlias,
  ): RouteBuilder<TBindings & Record<TAlias, UnwrapModel<TModel>>, TSchema>;
  bind<TModel extends ModelConstructor<any>, TParam extends string, TAlias extends string, TWith extends BindWithArg<TModel>>(
    model: TModel,
    param: TParam,
    alias: TAlias,
    options: { with: TWith },
  ): RouteBuilder<TBindings & Record<TAlias, BoundModel<TModel, TWith>>, TSchema>;
  bind<
    TModel extends ModelConstructor<any>,
    TParam extends string = "id",
    TAlias extends string = DefaultAliasFor<TModel>,
    TWith extends BindWithArg<TModel> | undefined = undefined,
  >(
    model: TModel,
    paramOrOptions?: TParam | { with?: TWith },
    aliasOrOptions?: TAlias | { with?: TWith },
    maybeOptions?: { with?: TWith },
  ): RouteBuilder<TBindings & Record<TAlias, BoundModel<TModel, TWith>>, TSchema> {
    let resolvedParam = "id";
    let resolvedAlias = defaultAliasForModel(model);
    let options: { with?: TWith } | undefined;

    if (typeof paramOrOptions === "string") {
      resolvedParam = paramOrOptions;
      if (typeof aliasOrOptions === "string") {
        resolvedAlias = aliasOrOptions;
        options = maybeOptions;
      } else {
        options = aliasOrOptions;
      }
    } else {
      options = paramOrOptions;
    }

    return new RouteBuilder(
      [...this.bindings, { model, param: resolvedParam, alias: resolvedAlias, with: options?.with }],
      this.schemaDef,
      { error: this.throwError, fail: this.makeFail },
    ) as any;
  }

  schema<S extends ValidationSchema | ValidationObjectSchema<any>>(
    schema: S,
  ): RouteBuilder<TBindings, S> {
    return new RouteBuilder(this.bindings, schema, {
      error: this.throwError,
      fail: this.makeFail,
    }) as any;
  }

  private async resolveBindings(event: RequestEventLike): Promise<TBindings> {
    const context: Record<string, unknown> = {};
    for (const binding of this.bindings) {
      const raw = event.params?.[binding.param];
      if (!raw) {
        bindError(this.throwError, binding.model, binding.alias, binding.param, "", "missing_param");
      }
      const paramValue = raw as string;
      const keyType = (binding.model as any).keyType as string | undefined;
      const usesUuids = Boolean((binding.model as any).usesUuids);
      if ((usesUuids || keyType === "uuid") && !isUuidLike(paramValue)) {
        bindError(this.throwError, binding.model, binding.alias, binding.param, paramValue, "invalid_uuid");
      }
      let record: unknown;
      try {
        record = await (binding.model as any).find(paramValue);
      } catch (err) {
        if (isInvalidUuidInputError(err)) {
          bindError(this.throwError, binding.model, binding.alias, binding.param, paramValue, "invalid_uuid");
        }
        throw err;
      }
      if (!record) {
        bindError(this.throwError, binding.model, binding.alias, binding.param, paramValue, "not_found");
      }
      if (binding.with) {
        await (record as any).load(binding.with as any);
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
      let data: unknown = undefined;
      if (this.schemaDef) {
        const parsed = await Validator.safeParse(this.schemaDef as any, event.request);
        if (!parsed.success) {
          return this.makeFail(422, {
            issues: parsed.issues,
            values: await requestValues(event.request),
          }) as TResult;
        }
        data = parsed.output;
      }

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

export function route(helpers: RouteKitHelpers = {}): RouteBuilder<{}, undefined> {
  return new RouteBuilder<{}, undefined>([], undefined, helpers);
}

export type { RequestEventLike, HandlerContext };
