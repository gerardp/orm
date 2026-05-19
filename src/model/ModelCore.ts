import { Connection } from "../connection/Connection.js";
import { Builder } from "../query/Builder.js";
import { Schema } from "../schema/Schema.js";
import { ConnectionManager } from "../connection/ConnectionManager.js";
import { TenantContext } from "../connection/TenantContext.js";
import { TransactionContext } from "../connection/TransactionContext.js";
import { IdentityMap } from "./IdentityMap.js";
import { ModelSchemaBuilder } from "./ModelSchemaBuilder.js";
import {
  modelProxyHandler,
  getGlobalScopes,
  globalScopes,
  globalScopesCache,
} from "./ModelBase.js";
import type {
  ModelConstructor,
  GlobalScope,
  CastDefinition,
  CastsAttributes,
  AccessorMap,
  ModelAttributeInput,
  BulkModelOptions,
} from "./ModelBase.js";
import { snakeCase } from "../utils.js";

export class ModelCore<T extends Record<string, any> = any> {
  static table: string;
  static primaryKey = "id";
  static timestamps = true;
  static connection?: Connection;
  static dateFormat = "YYYY-MM-DD HH:mm:ss";
  static keyType: "int" | "string" | "uuid" = "int";
  static incrementing = true;
  static usesUuids = false;
  static morphName?: string;
  static casts: Record<string, CastDefinition> = {};
  static fillable: string[] = [];
  static guarded: string[] = [];
  static attributes: Record<string, any> = {};
  static softDeletes = false;
  static deletedAtColumn = "deleted_at";
  static preventLazyLoading = false;
  static hidden: string[] = [];
  static visible: string[] = [];
  static appends: string[] = [];
  static accessors: AccessorMap<any, any> = {};
  static touches: string[] = [];

  $attributes = {} as T;
  $original = {} as Partial<T>;
  $changes = {} as Partial<T>;
  $exists = false;
  $relations: Record<string, any> = {};
  $casts: Record<string, CastDefinition> = {};
  $castCache: Record<string, any> = {};
  $mergedCasts: Record<string, CastDefinition> = {};
  $dirtyKeys?: Set<string>;
  $connection?: Connection;
  $hidden: string[] = [];
  $visible: string[] = [];
  $appends: string[] = [];
  $wasRecentlyCreated = false;

  constructor(attributes?: Partial<T>) {
    const ctor = Object.getPrototypeOf(this).constructor as typeof ModelCore;
    const staticCasts = ctor.casts || {};
    this.$mergedCasts = { ...staticCasts, ...this.$casts };
    const defaults = ctor.attributes || {};
    if (Object.keys(defaults).length > 0) {
      this.fill({ ...defaults } as Partial<T>);
    }
    if (attributes) {
      this.fill(attributes);
    }
    return new Proxy(this, modelProxyHandler);
  }

  static _defineBase<A extends Record<string, any>>(
    tableName: string,
    modelNameOrColumns?: string | Partial<Record<keyof A, string>>,
    columnsArg?: Partial<Record<keyof A, string>>
  ): any {
    const modelName = typeof modelNameOrColumns === "string" ? modelNameOrColumns : undefined;
    const columnHints = (typeof modelNameOrColumns === "object" ? modelNameOrColumns : columnsArg) as Record<string, string> | undefined;
    const name = modelName || tableName
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")
      .replace(/s$/, "");
    const Base = class extends (this as unknown as typeof ModelCore)<A> {
      static override table = tableName;
      static override casts: Record<string, CastDefinition> = columnHints ?? {};
      static override fillable: string[] = columnHints ? Object.keys(columnHints) : [];
    };
    Object.defineProperty(Base, "name", { value: name, writable: false, configurable: true });
    return Base;
  }

  static getTable(): string {
    return this.table || snakeCase(this.name) + "s";
  }

  static schema(): ModelSchemaBuilder {
    return new ModelSchemaBuilder(this.getTable(), this.getConnection(), {
      casts: this.casts,
      fillable: this.fillable,
      attributes: this.attributes,
      primaryKey: this.primaryKey,
      keyType: this.keyType,
      incrementing: this.incrementing,
      timestamps: this.timestamps,
      softDeletes: this.softDeletes,
      deletedAtColumn: this.deletedAtColumn,
      schemaDefinition: (this as any).schemaDefinition,
    });
  }

  static getConnection(): Connection {
    const transactionConnection = TransactionContext.current();
    if (transactionConnection) return transactionConnection;
    const tenantConnection = TenantContext.current()?.connection;
    const ownConnection = Object.prototype.hasOwnProperty.call(this, "connection") ? this.connection : undefined;
    const connection = tenantConnection || ownConnection || this.connection || ConnectionManager.getDefault();
    if (!connection) {
      throw new Error(`No connection set on model ${this.name}`);
    }
    return connection;
  }

  static setConnection(connection: Connection): void {
    this.connection = connection;
    ConnectionManager.setDefault(connection);
  }

  static useIdentityMap<T>(callback: () => T | Promise<T>): Promise<T> {
    return IdentityMap.run(callback);
  }

  static on<M extends ModelConstructor>(this: M, connection: string | Connection): Builder<InstanceType<M>> {
    const resolved = typeof connection === "string" ? ConnectionManager.require(connection) : connection;
    const builder = new Builder<InstanceType<M>>(resolved, resolved.qualifyTable((this as any).getTable()));
    builder.setModel(this);
    (this as any).applyGlobalScopes(builder);
    return builder;
  }

  static forTenant<M extends ModelConstructor>(this: M, tenantId: string): Builder<InstanceType<M>> {
    const context = ConnectionManager.getResolvedTenant(tenantId);
    if (!context) {
      throw new Error(`Tenant "${tenantId}" has not been resolved. Use TenantContext.run() or await ConnectionManager.resolveTenant() first.`);
    }
    return (this as any).on(context.connection);
  }

  static query<M extends ModelConstructor>(this: M): Builder<InstanceType<M>> {
    const connection = (this as any).getConnection();
    const builder = new Builder<InstanceType<M>>(connection, connection.qualifyTable((this as any).getTable()));
    builder.setModel(this);
    (this as any).applyGlobalScopes(builder);
    return builder;
  }

  static addGlobalScope(name: string, scope: GlobalScope): void {
    const scopes = globalScopes.get(this) || new Map<string, GlobalScope>();
    scopes.set(name, scope);
    globalScopes.set(this, scopes);
    globalScopesCache.delete(this);
  }

  static removeGlobalScope(name: string): void {
    globalScopes.get(this)?.delete(name);
    globalScopesCache.delete(this);
  }

  static applyGlobalScopes(builder: Builder<any>): void {
    if (this.softDeletes) {
      builder.whereNull((this as any).getQualifiedDeletedAtColumn(), "and", "softDeletes");
    }
    for (const [name, scope] of getGlobalScopes(this)) {
      scope(builder, this);
      for (const where of builder.wheres) {
        if (!where.scope) where.scope = name;
      }
    }
  }

  static getQualifiedDeletedAtColumn(): string {
    return `${(this as any).getTable()}.${this.deletedAtColumn}`;
  }

  // Instance methods
  fill(attributes: Partial<T> | ModelAttributeInput<this>): this {
    for (const [key, value] of Object.entries(attributes)) {
      if (this.isFillable(key)) {
        this.setAttribute(key as any, value as any);
      }
    }
    return this;
  }

  setConnection(connection: Connection): this {
    this.$connection = connection;
    return this;
  }

  getConnection(): Connection {
    return this.$connection || (this.getModelConstructor() as typeof ModelCore).getConnection();
  }

  getModelConstructor(): typeof ModelCore {
    return Object.getPrototypeOf(this).constructor as typeof ModelCore;
  }

  isFillable(key: string): boolean {
    const constructor = this.getModelConstructor();
    const fillable = constructor.fillable || [];
    const guarded = constructor.guarded || [];
    if (fillable.length > 0) {
      return fillable.includes(key);
    }
    if (guarded.length > 0) {
      return !guarded.includes(key);
    }
    return true;
  }

  getAttribute<K extends keyof T>(key: K): T[K];
  getAttribute(key: string): any;
  getAttribute(key: string | keyof T): any {
    const accessors = (Object.getPrototypeOf(this).constructor as any).accessors || {};
    if (key in accessors && accessors[key as string].get) {
      return accessors[key as string].get!((this.$attributes as any)[key], this.$attributes as any, this);
    }
    if (Object.prototype.hasOwnProperty.call(this.$castCache, key as string)) {
      return this.$castCache[key as string];
    }
    const value = (this.$attributes as any)[key];
    const casted = this.castAttribute(key as string, value);
    if (this.getCastDefinition(key as string) && value !== null && value !== undefined) {
      this.$castCache[key as string] = casted;
    }
    return casted;
  }

  setAttribute<K extends keyof T>(key: K, value: T[K]): void;
  setAttribute(key: string, value: any): void;
  setAttribute(key: string | keyof T, value: any): void {
    const accessors = (Object.getPrototypeOf(this).constructor as any).accessors || {};
    if (key in accessors && accessors[key as string].set) {
      (this.$attributes as any)[key] = accessors[key as string].set!(value, this.$attributes as any, this);
      delete this.$castCache[key as string];
      return;
    }
    const serialized = this.serializeCastAttribute(key as string, value);
    const original = (this.$original as any)[key];
    if (original !== serialized) {
      (this.$dirtyKeys ??= new Set()).add(key as string);
    } else {
      this.$dirtyKeys?.delete(key as string);
    }
    (this.$attributes as any)[key] = serialized;
    delete this.$castCache[key as string];
  }

  castAttribute(key: string, value: any): any {
    const cast = this.getCastDefinition(key);
    if (!cast || value === null || value === undefined) return value;
    const custom = this.resolveCustomCast(cast);
    if (custom) return custom.get(this, key, value, this.$attributes);
    const [type, argument] = String(cast).split(":");

    switch (type) {
      case "boolean":
      case "bool":
        return !!value;
      case "number":
      case "integer":
      case "int":
      case "float":
      case "double":
        return Number(value);
      case "decimal":
        return Number(value).toFixed(Number(argument || 2));
      case "string":
        return String(value);
      case "date":
      case "datetime":
        return new Date(value);
      case "json":
      case "array":
        return typeof value === "string" ? JSON.parse(value) : value;
      case "object":
        return typeof value === "string" ? JSON.parse(value) : value;
      case "enum":
        return value;
      case "encrypted":
        return typeof value === "string" ? Buffer.from(value, "base64").toString("utf8") : value;
      default:
        return value;
    }
  }

  serializeCastAttribute(key: string, value: any): any {
    const cast = this.getCastDefinition(key);
    if (!cast || value === null || value === undefined) return value;
    const custom = this.resolveCustomCast(cast);
    if (custom) return custom.set(this, key, value, this.$attributes);
    const [type, argument] = String(cast).split(":");

    switch (type) {
      case "boolean":
      case "bool":
        return value ? 1 : 0;
      case "number":
      case "integer":
      case "int":
      case "float":
      case "double":
        return Number(value);
      case "decimal":
        return Number(value).toFixed(Number(argument || 2));
      case "string":
        return String(value);
      case "date":
      case "datetime":
        return value instanceof Date ? value.toISOString() : value;
      case "json":
      case "array":
      case "object":
        return typeof value === "string" ? value : JSON.stringify(value);
      case "enum":
        return typeof value === "object" && "value" in value ? value.value : value;
      case "encrypted":
        return Buffer.from(String(value), "utf8").toString("base64");
      default:
        return value;
    }
  }

  mergeCasts(casts: Record<string, CastDefinition>): this {
    this.$casts = { ...this.$casts, ...casts };
    const ctor = this.getModelConstructor();
    this.$mergedCasts = { ...(ctor.casts || {}), ...this.$casts };
    this.$castCache = {};
    return this;
  }

  protected getCastDefinition(key: string): CastDefinition | undefined {
    return this.$mergedCasts[key];
  }

  protected resolveCustomCast(cast: CastDefinition): CastsAttributes | null {
    if (typeof cast === "string") return null;
    if (typeof cast === "function") return new cast();
    if (typeof cast.get === "function" && typeof cast.set === "function") return cast;
    return null;
  }

  getDirty(): Partial<T> {
    const dirty: Partial<T> = {};
    const keys = this.$dirtyKeys;
    if (!keys) return dirty;
    for (const key of keys) {
      if ((this.$original as any)[key] !== (this.$attributes as any)[key]) {
        (dirty as any)[key] = (this.$attributes as any)[key];
      }
    }
    return dirty;
  }

  isDirty(): boolean {
    return Object.keys(this.getDirty()).length > 0;
  }

  wasChanged(key?: string): boolean {
    if (key !== undefined) return key in this.$changes;
    return Object.keys(this.$changes).length > 0;
  }

  getChanges(): Partial<T> {
    return { ...this.$changes };
  }

  getOriginal(): Partial<T>;
  getOriginal<K extends keyof T>(key: K): T[K] | undefined;
  getOriginal(key?: string): any {
    if (key !== undefined) return (this.$original as any)[key];
    return { ...this.$original };
  }

  replicate(except?: string[]): this {
    const constructor = this.getModelConstructor();
    const pk = constructor.primaryKey;
    const exclude = new Set([pk, "created_at", "updated_at", ...(except || [])]);
    const attrs: Record<string, any> = {};
    for (const [key, value] of Object.entries(this.$attributes)) {
      if (!exclude.has(key)) attrs[key] = value;
    }
    const instance = new (constructor as any)() as this;
    instance.fill(attrs as any);
    return instance;
  }

  freshTimestamp(): string {
    return new Date().toISOString();
  }

  setRelation(name: string, value: any): void {
    this.$relations[name] = value;
  }

  getRelation(name: string): any {
    return this.$relations[name];
  }

  is(other: ModelCore | null | undefined): boolean {
    if (!other) return false;
    const ctor = this.getModelConstructor();
    const otherCtor = Object.getPrototypeOf(other).constructor as typeof ModelCore;
    return ctor.getTable() === otherCtor.getTable() &&
      String(this.getAttribute(ctor.primaryKey)) === String(other.getAttribute(otherCtor.primaryKey));
  }

  isInstanceOf<M extends ModelConstructor<any>>(modelClass: M): this is InstanceType<M> {
    return (this.getModelConstructor() as unknown) === modelClass;
  }

  isNot(other: ModelCore | null | undefined): boolean {
    return !this.is(other);
  }

  updateTimestamps(): void {
    const constructor = this.getModelConstructor();
    if (!constructor.timestamps) return;
    const now = this.freshTimestamp();
    (this.$attributes as any)["updated_at"] = now;
    delete this.$castCache.updated_at;
    if (!this.$exists) {
      (this.$attributes as any)["created_at"] = now;
      delete this.$castCache.created_at;
    }
  }
}
