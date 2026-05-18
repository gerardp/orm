import type { Connection } from "../connection/Connection.js";
import type { Builder } from "../query/Builder.js";

export type ModelConstructor<T = any> = (new (...args: any[]) => T) & Omit<any, "prototype">;
export type GlobalScope = (builder: Builder<any>, model: ModelConstructor) => void;
export type LiteralUnion<T extends string> = T | (string & {});
export type EagerLoadConstraint = (query: Builder<any>) => void | Builder<any>;
export interface EagerLoadDefinition {
  name: string;
  constraint?: EagerLoadConstraint;
}
export type EagerLoadInput =
  | string
  | EagerLoadDefinition
  | Record<string, EagerLoadConstraint | undefined>;
export type MorphEagerLoadMap = Record<string, EagerLoadInput | EagerLoadInput[]>;
export type MorphCountLoadMap = Record<string, string | string[]>;

type BaseModelInstanceKey =
  | "$attributes"
  | "$original"
  | "$changes"
  | "$exists"
  | "$relations"
  | "$casts"
  | "$castCache"
  | "$connection"
  | "$hidden"
  | "$visible"
  | "$wasRecentlyCreated"
  | "fill"
  | "setConnection"
  | "getConnection"
  | "isFillable"
  | "getAttribute"
  | "setAttribute"
  | "castAttribute"
  | "serializeCastAttribute"
  | "mergeCasts"
  | "getDirty"
  | "isDirty"
  | "wasChanged"
  | "getChanges"
  | "getOriginal"
  | "replicate"
  | "makeHidden"
  | "makeVisible"
  | "append"
  | "setAppends"
  | "getAppends"
  | "save"
  | "update"
  | "updateTimestamps"
  | "touch"
  | "increment"
  | "decrement"
  | "is"
  | "isNot"
  | "load"
  | "loadMorph"
  | "loadCount"
  | "loadSum"
  | "loadAvg"
  | "loadMin"
  | "loadMax"
  | "delete"
  | "saveQuietly"
  | "deleteQuietly"
  | "restore"
  | "forceDelete"
  | "refresh"
  | "toJSON"
  | "json"
  | "toString"
  | "freshTimestamp"
  | "setRelation"
  | "getRelation"
  | "hasMany"
  | "belongsTo"
  | "hasOne"
  | "hasManyThrough"
  | "hasOneThrough"
  | "belongsToMany"
  | "morphTo"
  | "morphOne"
  | "morphMany"
  | "morphToMany"
  | "morphedByMany";

export type ModelInstanceAttributeKeys<T> = Extract<Exclude<keyof T, BaseModelInstanceKey>, string>;
export type ModelAttributes<T> = T extends { $attributes: Record<string, any> }
  ? string extends keyof T["$attributes"]
    ? Pick<T, ModelInstanceAttributeKeys<T>>
    : T["$attributes"]
  : T;
export type ModelColumn<T> = LiteralUnion<Extract<keyof ModelAttributes<T>, string>>;
export type ModelColumnValue<T, K> = K extends keyof ModelAttributes<T> ? ModelAttributes<T>[K] : any;
export type ModelAttributeInput<T> = Partial<ModelAttributes<T>> & Record<string, any>;
export type StripTablePrefix<S extends string> = S extends `${string}.${infer Tail}` ? Tail : S;
export type ModelAttributeInputWithout<T, K extends string> = Partial<Omit<ModelAttributes<T>, K>> & Record<string, any>;
export type MorphRelationInput<T, N extends string, Fixed extends string = never> = ModelAttributeInputWithout<T, Fixed | `${N}_id` | `${N}_type`>;

export interface BulkModelOptions {
  chunkSize?: number;
  events?: boolean;
}
export interface SaveOptions {
  events?: boolean;
}

export type CastDefinition =
  | string
  | CastsAttributes
  | (new (...args: any[]) => CastsAttributes);

export interface CastsAttributes {
  get(model: any, key: string, value: any, attributes: Record<string, any>): any;
  set(model: any, key: string, value: any, attributes: Record<string, any>): any;
}

type BivariantCallback<TArgs extends any[], TResult> = {
  bivarianceHack(...args: TArgs): TResult;
}["bivarianceHack"];

export interface AttributeDefinition<
  TAttributes extends Record<string, any> = Record<string, any>,
  TModel = any
> {
  get?: BivariantCallback<[value: any, attributes: TAttributes, model: TModel], any>;
  set?: BivariantCallback<[value: any, attributes: TAttributes, model: TModel], any>;
}

export type AccessorMap<
  TAttributes extends Record<string, any> = Record<string, any>,
  TModel = any
> = Record<string, AttributeDefinition<TAttributes, TModel>>;
