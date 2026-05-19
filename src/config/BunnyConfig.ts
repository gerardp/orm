import { redis } from "bun";
import { Connection } from "../connection/Connection.js";
import { ConnectionManager } from "../connection/ConnectionManager.js";
import type { TenantResolver } from "../connection/ConnectionManager.js";
import { Cache, RedisCacheStore } from "../cache/index.js";
import type { CacheStore } from "../cache/index.js";
import { Model } from "../model/Model.js";
import { Schema } from "../schema/Schema.js";
import { Migrator, type MigratorOptions } from "../migration/Migrator.js";
import { SeederRunner } from "../seeding/Seeder.js";
import { TenantContext } from "../connection/TenantContext.js";
import type { ModelDeclaration } from "../typegen/TypeGenerator.js";
import type { ConnectionConfig } from "../types/index.js";
import { Queue } from "../queue/Queue.js";
import { DatabaseQueueDriver } from "../queue/DatabaseQueueDriver.js";
import type { QueueDriver } from "../queue/QueueDriver.js";

export interface ModelsPath {
  landlord?: string | string[];
  tenant?: string | string[];
}

export interface BunnyConfig {
  connection: ConnectionConfig;
  migrationsPath?: string | string[];
  seedersPath?: string | string[];
  migrations?: {
    landlord?: string | string[];
    tenant?: string | string[];
    createIfMissing?: boolean | {
      database?: boolean;
      schema?: boolean;
    };
  };
  tenancy?: {
    resolveTenant?: TenantResolver;
    listTenants?: () => string[] | Promise<string[]>;
    /** Default idle TTL (ms) for tenant contexts that own a connection pool. Reclaims idle per-tenant pools. */
    idleTimeoutMs?: number;
    /** Enable the background sweep that closes expired tenant pools. Interval in ms (default 60000 when true). */
    sweep?: boolean | number;
  };
  modelsPath?: string | string[] | ModelsPath;
  typesOutDir?: string;
  typeDeclarations?: Record<string, string | ModelDeclaration>;
  typeDeclarationModelsDir?: string;
  typeDeclarationImportPrefix?: string;
  typeDeclarationSingularModels?: boolean;
  typeStubs?: boolean;
  log?: boolean | { file?: string; console?: boolean };
  transactions?: {
    /** Safety net (ms): a manual beginTransaction() with no commit/rollback within this window is auto-rolled-back and its pooled connection released. Opt-in. */
    abandonedTimeoutMs?: number;
  };
  cache?: {
    store?: CacheStore;
    prefix?: string;
    defaultTtl?: number;
  };
  queue?: {
    driver?: QueueDriver;
    defaultQueue?: string;
    workers?: number;
    jobsPath?: string | string[];
    retryAfterSeconds?: number;
    table?: string;
    failedTable?: string;
  };
  commands?: {
    commandsPath?: string | string[];
  };
}

export interface ConfiguredBunny {
  config: BunnyConfig;
  connection: Connection;
  migrator(scope?: "landlord" | "tenant", overrides?: MigratorOptions): Migrator;
  seeder(): SeederRunner;
  migrate(scope?: "landlord" | "tenant", overrides?: MigratorOptions): Promise<void>;
  rollback(steps?: number, scope?: "landlord" | "tenant"): Promise<void>;
  fresh(scope?: "landlord" | "tenant"): Promise<void>;
  seed(): Promise<void>;
}

function resolveMigrationPath(config: BunnyConfig, scope: "landlord" | "tenant"): string | string[] {
  const grouped = config.migrations?.[scope];
  if (grouped) return grouped;
  if (config.migrationsPath) return config.migrationsPath;
  throw new Error(`No migration path configured for scope "${scope}".`);
}

export function configureBunny(config: BunnyConfig): ConfiguredBunny {
  void ConnectionManager.closeAll().catch(() => {});
  const connection = new Connection(config.connection);
  ConnectionManager.setDefault(connection);
  Model.setConnection(connection);
  Schema.setConnection(connection);

  if (config.tenancy?.resolveTenant) {
    ConnectionManager.setTenantResolver(config.tenancy.resolveTenant);

    // Defaults applied only when tenancy is in use: idle per-tenant pools
    // are reclaimed unless the app explicitly opts out.
    ConnectionManager.defaultTenantTtl =
      config.tenancy.idleTimeoutMs ?? 300_000;

    const sweep = config.tenancy.sweep ?? true;
    if (sweep !== false && sweep !== 0) {
      ConnectionManager.enableTenantSweep(typeof sweep === "number" ? sweep : 60_000);
    }
  }

  // Global safety net for abandoned manual transactions. Default 60s;
  // set transactions.abandonedTimeoutMs = 0 to disable.
  Connection.abandonedTransactionTimeoutMs =
    config.transactions?.abandonedTimeoutMs ?? 60_000;

  const logConfig = config.log;
  if (logConfig === true) {
    Connection.logQueries = true;
    Connection.logToConsole = true;
  } else if (logConfig && typeof logConfig === 'object') {
    Connection.logQueries = true;
    Connection.queryLogFile = logConfig.file;
    Connection.logToConsole = logConfig.console ?? false;
  }

  if (config.cache) {
    Cache.configure({
      store: config.cache.store ?? new RedisCacheStore(redis),
      prefix: config.cache.prefix,
      defaultTtl: config.cache.defaultTtl,
    });
  }

  if (config.queue) {
    const queueDriver = config.queue.driver ?? new DatabaseQueueDriver(connection, {
      table: config.queue.table,
      failedTable: config.queue.failedTable,
    });
    Queue.configure(queueDriver, config.queue.defaultQueue ?? "default");
  }

  const buildMigrator = (scope: "landlord" | "tenant" = "landlord", overrides: MigratorOptions = {}) => {
    const path = resolveMigrationPath(config, scope);
    const tenantConn = TenantContext.current()?.connection;
    const activeConn = tenantConn ?? connection;
    const options: MigratorOptions = {
      createIfMissing: config.migrations?.createIfMissing,
      ...overrides,
    };
    return new Migrator(activeConn, path, config.typesOutDir, {}, options);
  };

  const buildSeeder = () => {
    const tenantConn = TenantContext.current()?.connection;
    return new SeederRunner(tenantConn ?? connection);
  };

  return {
    config,
    connection,
    migrator: buildMigrator,
    seeder: buildSeeder,
    async migrate(scope = "landlord", overrides = {}) {
      await buildMigrator(scope, overrides).run();
    },
    async rollback(steps = 1, scope = "landlord") {
      await buildMigrator(scope).rollback(steps);
    },
    async fresh(scope = "landlord") {
      await buildMigrator(scope).fresh();
    },
    async seed() {
      if (!config.seedersPath) {
        throw new Error("No seedersPath configured.");
      }
      await buildSeeder().runPaths(config.seedersPath);
    },
  };
}
