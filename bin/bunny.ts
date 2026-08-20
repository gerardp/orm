#!/usr/bin/env bun
import { redis, SQL } from "bun";
import { Connection } from "../src/connection/Connection.js";
import { ConnectionManager } from "../src/connection/ConnectionManager.js";
import { TenantContext } from "../src/connection/TenantContext.js";
import { configureBunny } from "../src/config/BunnyConfig.js";
import type { BunnyConfig } from "../src/config/BunnyConfig.js";
import { Migrator } from "../src/migration/Migrator.js";
import { MigrationCreator } from "../src/migration/MigrationCreator.js";
import { SeederRunner } from "../src/seeding/Seeder.js";
import { TypeGenerator } from "../src/typegen/TypeGenerator.js";
import { existsSync } from "fs";
import { mkdir, mkdtempDisposable, readdir, writeFile } from "fs/promises";
import { basename, extname, join, resolve, sep } from "path";
import { pathToFileURL } from "url";
import { styleText } from "node:util";
import { normalizePathList, snakeCase } from "../src/utils.js";
import { discoverModelTables } from "../src/typegen/discoverModelTables.js";
import type { ModelsPath } from "../src/config/BunnyConfig.js";
import { DatabaseQueueDriver } from "../src/queue/DatabaseQueueDriver.js";
import { RedisQueueDriver } from "../src/queue/RedisQueueDriver.js";
import type { QueueDriver } from "../src/queue/QueueDriver.js";
import { Worker } from "../src/queue/Worker.js";
import { registerJob } from "../src/queue/Job.js";
import { registerCommand, resolveCommand, listCommands, isCommandConstructor } from "../src/commands/Command.js";
import { CommandRunner } from "../src/commands/CommandRunner.js";
import { parseSignatureName } from "../src/commands/SignatureParser.js";
import { registerOrmCommands } from "../src/cli/index.js";
import {
  BelongsTo,
  BelongsToMany,
  Blueprint,
  Grammar,
  HasMany,
  HasManyThrough,
  HasOne,
  HasOneThrough,
  Migration,
  MorphMany,
  MorphMap,
  MorphOne,
  MorphTo,
  MorphToMany,
  MySqlGrammar,
  ObserverRegistry,
  PostgresGrammar,
  Schema,
  SQLiteGrammar,
  TypeMapper,
  Builder,
  Model,
} from "../src/index.js";

type MigrationCommand = "migrate" | "migrate:rollback" | "migrate:status" | "migrate:reset" | "migrate:refresh" | "migrate:fresh";
type MigrationTarget =
  | { scope: "default" }
  | { scope: "landlord" }
  | { scope: "tenants" }
  | { scope: "tenant"; tenantId: string };

function parseEnvPathSetting(value?: string): string | string[] | undefined {
  if (!value) return undefined;
  const paths = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (paths.length === 0) return undefined;
  return paths.length === 1 ? paths[0] : paths;
}

function hasLocalBunnyConfig(): boolean {
  const tsConfigPath = join(process.cwd(), "bunny.config.ts");
  const jsConfigPath = join(process.cwd(), "bunny.config.js");
  return existsSync(tsConfigPath) || existsSync(jsConfigPath);
}

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function resolveReplTmpRoot(): string {
  return process.env.BUNNY_REPL_TMPDIR || process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
}

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  if (!isInteractiveTerminal()) return defaultYes;
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  for (;;) {
    process.stdout.write(`${question}${suffix}`);
    const input = await new Promise<string>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
    });
    if (!input) return defaultYes;
    const normalized = input.toLowerCase();
    if (["y", "yes"].includes(normalized)) return true;
    if (["n", "no"].includes(normalized)) return false;
    process.stdout.write("Please answer yes or no.\n");
  }
}

async function promptText(question: string, defaultValue: string): Promise<string> {
  if (!isInteractiveTerminal()) return defaultValue;
  process.stdout.write(`${question} (${defaultValue}): `);
  const input = await new Promise<string>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
  });
  return input || defaultValue;
}

function buildBunnyConfigTemplate(opts: {
  databaseUrl: string;
  migrationsPath: string;
  seedersPath: string;
  modelsPath: string;
  enableTenancy: boolean;
  enableSearch: boolean;
  enableQueue: boolean;
  enableCache: boolean;
  enableLogs: boolean;
  commandsPath: string;
}): string {
  const lines: string[] = [
    `import type { BunnyConfig } from "@bunnykit/orm";`,
    "",
    "const config: BunnyConfig = {",
    "  connection: {",
    "    // Update this to your database URL.",
    '    // Examples: "sqlite://./database/app.db", "postgres://user:pass@localhost:5432/app"',
    `    url: process.env.DATABASE_URL || "${opts.databaseUrl}",`,
    "  },",
    `  migrationsPath: "${opts.migrationsPath}",`,
    `  seedersPath: "${opts.seedersPath}",`,
    `  modelsPath: "${opts.modelsPath}",`,
    `  commands: { commandsPath: "${opts.commandsPath}" },`,
  ];

  if (opts.enableLogs) {
    lines.push(
      "  log: {",
      "    console: true,",
      '    // file: "./storage/logs/sql.log",',
      "  },",
    );
  }

  if (opts.enableTenancy) {
    lines.push(
      "  tenancy: {",
      "    // Replace with your own resolver and tenant lister.",
      "    // resolveTenant: async () => null,",
      "    // listTenants: async () => [\"tenant-1\"],",
      "    idleTimeoutMs: 300_000,",
      "  },",
    );
  }

  if (opts.enableSearch) {
    lines.push(
      "  search: {",
      "    engine: \"sqlite\",",
      "    chunk: 500,",
      ...(opts.enableTenancy
        ? [
          "    // Keep search indexes tenant-scoped when tenancy is enabled.",
          "    tenantScope: (base, tenantId) => tenantId ? `${base}_t_${tenantId}` : base,",
        ]
        : []),
      "    // For Meilisearch, switch engine and set host/apiKey:",
      "    // engine: \"meilisearch\",",
      "    // host: process.env.MEILISEARCH_HOST || \"http://127.0.0.1:7700\",",
      "    // apiKey: process.env.MEILISEARCH_API_KEY,",
      "  },",
    );
  }

  if (opts.enableQueue) {
    lines.push(
      "  queue: {",
      "    driver: \"db\",",
      "    defaultQueue: \"default\",",
      "    workers: 1,",
      "    jobsPath: \"./app/jobs\",",
      "  },",
    );
  }

  if (opts.enableCache) {
    lines.push(
      "  cache: {",
      "    // Default is Redis cache store from Bun's Redis client.",
      "    prefix: \"bunny:\",",
      "    defaultTtl: 3600,",
      "  },",
    );
  }

  lines.push("};", "", "export default config;", "");
  return lines.join("\n");
}

async function buildInitTemplateFromPrompts(): Promise<string> {
  const databaseUrl = await promptText("Database URL", "sqlite://./database/app.db");
  const migrationsPath = await promptText("Migrations path", "./database/migrations");
  const seedersPath = await promptText("Seeders path", "./database/seeders");
  const modelsPath = await promptText("Models path", "./app/models");
  const commandsPath = await promptText("Commands path", "./app/commands");

  const enableTenancy = await promptYesNo("Add multitenancy section?", false);
  const enableSearch = await promptYesNo("Add search section?", true);
  const enableQueue = await promptYesNo("Add queue section?", true);
  const enableCache = await promptYesNo("Add cache section?", false);
  const enableLogs = await promptYesNo("Enable SQL logging section?", false);

  return buildBunnyConfigTemplate({
    databaseUrl,
    migrationsPath,
    seedersPath,
    modelsPath,
    commandsPath,
    enableTenancy,
    enableSearch,
    enableQueue,
    enableCache,
    enableLogs,
  });
}

async function runInitCommand(rawArgs: string[]): Promise<number> {
  const force = rawArgs.includes("--force") || rawArgs.includes("-f");
  const tsConfigPath = join(process.cwd(), "bunny.config.ts");
  const jsConfigPath = join(process.cwd(), "bunny.config.js");
  const tsExists = existsSync(tsConfigPath);
  const jsExists = existsSync(jsConfigPath);

  if ((tsExists || jsExists) && !force) {
    const existing = tsExists ? tsConfigPath : jsConfigPath;
    console.error(`${styleText("red", "Config already exists:", { stream: process.stderr })} ${existing}`);
    console.error("Use `bunny init --force` to overwrite `bunny.config.ts`.");
    return 1;
  }

  const template = await buildInitTemplateFromPrompts();
  await writeFile(tsConfigPath, template, "utf-8");
  console.log(`${styleText("green", "Created:")} ${tsConfigPath}`);
  if (jsExists) {
    console.warn(`${styleText("yellow", "Note:", { stream: process.stderr })} ${jsConfigPath} still exists and may cause confusion.`);
  }
  return 0;
}

function getDefaultMigrationsPath(config: BunnyConfig): string | string[] {
  return config.migrationsPath || config.migrations?.landlord || "./database/migrations";
}

function getFirstMigrationPath(path: string | string[] | undefined): string | undefined {
  return normalizePathList(path).filter(Boolean)[0];
}

function parseMigrationTarget(args: string[]): MigrationTarget {
  if (args.includes("--landlord")) return { scope: "landlord" };
  if (args.includes("--tenants")) return { scope: "tenants" };
  const tenantFlagIndex = args.indexOf("--tenant");
  if (tenantFlagIndex >= 0) {
    const tenantId = args[tenantFlagIndex + 1];
    if (!tenantId) {
      throw new Error("Usage: bun run bunny migrate --tenant <tenantId>");
    }
    return { scope: "tenant", tenantId };
  }
  return { scope: "default" };
}

function parseSeederInvocation(args: string[]): { target?: string; scope: MigrationTarget } {
  const flags: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--landlord" || arg === "--tenants") {
      flags.push(arg);
      continue;
    }
    if (arg === "--tenant") {
      const tenantId = args[++i];
      if (!tenantId) {
        throw new Error("Usage: bun run bunny db:seed [--tenant <tenantId>] [seeder]");
      }
      flags.push(arg, tenantId);
      continue;
    }
    rest.push(arg);
  }
  return {
    target: rest[0],
    scope: parseMigrationTarget(flags),
  };
}

function getModelPaths(config: BunnyConfig): { landlord?: string | string[]; tenant?: string | string[] } {
  const mp = config.modelsPath;
  if (mp && typeof mp === "object" && !Array.isArray(mp)) {
    return mp as ModelsPath;
  }
  return { landlord: mp as string | string[] | undefined, tenant: mp as string | string[] | undefined };
}

function getScopeExclusions(ourModels: string | string[] | undefined, otherModels: string | string[] | undefined): string[] | undefined {
  if (!ourModels || !otherModels) return undefined;
  const ourRoots = normalizePathList(ourModels).map((r) => resolve(process.cwd(), r));
  const otherRoots = normalizePathList(otherModels).map((r) => resolve(process.cwd(), r));
  return otherRoots.filter((other) =>
    ourRoots.some((our) => other.startsWith(our + sep) || other === our)
  );
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1) return args[idx + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

async function walkJobFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkJobFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.endsWith(".d.ts") || name.endsWith(".test.ts") || name.endsWith(".spec.ts")) continue;
    if (![".ts", ".js", ".mts", ".mjs"].includes(extname(name))) continue;
    files.push(fullPath);
  }
  return files;
}

function parseTypeGenerateArgs(args: string[]): { outDir?: string; target: MigrationTarget } {
  const flags: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--landlord" || arg === "--tenants") {
      flags.push(arg);
      continue;
    }
    if (arg === "--tenant") {
      const tenantId = args[++i];
      if (!tenantId) {
        throw new Error("Usage: bun run bunny types:generate [--landlord | --tenant <id>] [dir]");
      }
      flags.push(arg, tenantId);
      continue;
    }
    rest.push(arg);
  }
  return {
    outDir: rest[0],
    target: parseMigrationTarget(flags),
  };
}

function createTypeGeneratorOptions(config: BunnyConfig, modelsPathOverride?: string | string[]) {
  const modelRoots = normalizePathList(modelsPathOverride ?? (typeof config.modelsPath === "string" || Array.isArray(config.modelsPath) ? config.modelsPath : undefined) ?? config.typeDeclarationModelsDir);
  return {
    declarations: !config.typeStubs,
    stubs: config.typeStubs,
    modelDeclarations: config.typeDeclarations,
    modelDirectory: modelRoots[0],
    modelDirectories: modelRoots.length > 1 ? modelRoots : undefined,
    modelImportPrefix: config.typeDeclarationImportPrefix,
    singularModels: config.typeDeclarationSingularModels,
    declarationDirName: "types",
  };
}

function createMigrationOptions(config: BunnyConfig) {
  return {
    createIfMissing: config.migrations?.createIfMissing,
  };
}

function buildMigrator(
  config: BunnyConfig,
  connection: Connection,
  path: string | string[],
  scope: "landlord" | "tenant",
  extraOptions: Record<string, any> = {}
): Migrator {
  return new Migrator(
    connection,
    path,
    config.typesOutDir,
    createTypeGeneratorOptions(config, getModelPaths(config)[scope]),
    { ...createMigrationOptions(config), ...extraOptions }
  );
}

async function runMigratorCommand(
  command: MigrationCommand,
  migrator: Migrator,
  statusLabel?: string
): Promise<void> {
  if (command === "migrate") {
    await migrator.run();
    return;
  }
  if (command === "migrate:rollback") {
    await migrator.rollback();
    return;
  }
  if (command === "migrate:reset") {
    await migrator.reset();
    return;
  }
  if (command === "migrate:refresh") {
    await migrator.refresh();
    return;
  }
  if (command === "migrate:fresh") {
    await migrator.fresh();
    return;
  }
  const status = await migrator.status();
  if (statusLabel) {
    console.log(statusLabel);
  }
  console.table(status);
}

async function getTenantIds(config: BunnyConfig): Promise<string[]> {
  if (!config.tenancy?.listTenants) {
    throw new Error("Tenant migrations require tenancy.listTenants() in bunny.config.ts.");
  }
  const tenantIds = await config.tenancy.listTenants();
  return tenantIds.map((tenantId) => String(tenantId));
}

async function runTenantMigrator(
  command: MigrationCommand,
  config: BunnyConfig,
  connectionPath: string | string[],
  tenantId: string,
  typesOutDir?: string
): Promise<void> {
  await TenantContext.run(tenantId, async () => {
    const context = TenantContext.current();
    if (!context) {
      throw new Error(`Tenant "${tenantId}" did not resolve to an active context.`);
    }
    console.log(`Tenant: ${tenantId}`);
    const migrator = buildMigrator(
      typesOutDir ? { ...config, typesOutDir } : config,
      context.connection,
      connectionPath,
      "tenant",
      { tenantId }
    );
    await runMigratorCommand(command, migrator);
  });
}

async function runSeederCommand(
  config: BunnyConfig,
  connection: Connection,
  scope: MigrationTarget,
  target?: string
): Promise<void> {
  const seederPath = config.seedersPath || "./database/seeders";
  const runner = new SeederRunner(connection);

  const runDefault = async () => {
    if (target) {
      await runner.runTarget(target, seederPath);
      return;
    }
    await runner.runPaths(seederPath);
  };

  if (scope.scope === "default" || scope.scope === "landlord") {
    await runDefault();
    return;
  }

  if (!config.tenancy?.resolveTenant) {
    throw new Error("Tenant seeding requires tenancy.resolveTenant() in bunny.config.ts.");
  }
  ConnectionManager.setTenantResolver(config.tenancy.resolveTenant);

  if (scope.scope === "tenant") {
    await TenantContext.run(scope.tenantId, async () => {
      await runDefault();
    });
    return;
  }

  const tenantIds = await getTenantIds(config);
  for (const tenantId of tenantIds) {
    await TenantContext.run(tenantId, async () => {
      await runDefault();
    });
  }
}

async function runTenantMigrationCommand(
  command: MigrationCommand,
  config: BunnyConfig,
  tenantPath: string | string[],
  tenantId: string,
  typesOutDir?: string
): Promise<void> {
  try {
    await runTenantMigrator(command, config, tenantPath, tenantId, typesOutDir);
  } finally {
    await ConnectionManager.closeTenant(tenantId);
  }
}

async function runConfiguredMigrationCommand(
  command: MigrationCommand,
  config: BunnyConfig,
  connection: Connection,
  target: MigrationTarget
): Promise<void> {
  const previousConnectionLogQueries = connection.logQueries;
  const previousGlobalLogQueries = Connection.logQueries;
  connection.logQueries = false;
  Connection.logQueries = false;
  try {
    await runConfiguredMigrationCommandWithoutSqlLogging(command, config, connection, target);
  } finally {
    connection.logQueries = previousConnectionLogQueries;
    Connection.logQueries = previousGlobalLogQueries;
  }
}

async function runConfiguredMigrationCommandWithoutSqlLogging(
  command: MigrationCommand,
  config: BunnyConfig,
  connection: Connection,
  target: MigrationTarget
): Promise<void> {
  if (!config.migrations) {
    const defaultPath = getDefaultMigrationsPath(config);
    if (target.scope === "tenant" || target.scope === "tenants") {
      if (!config.tenancy?.resolveTenant) {
        throw new Error("Tenant migrations require tenancy.resolveTenant() in bunny.config.ts.");
      }
      ConnectionManager.setTenantResolver(config.tenancy.resolveTenant);
      if (target.scope === "tenant") {
        await runTenantMigrationCommand(command, config, defaultPath, target.tenantId, config.typesOutDir);
        return;
      }
      const tenantIds = await getTenantIds(config);
      for (const tenantId of tenantIds) {
        await runTenantMigrationCommand(command, config, defaultPath, tenantId, config.typesOutDir);
      }
      return;
    }
    const migrator = buildMigrator(config, connection, defaultPath, "landlord");
    await runMigratorCommand(command, migrator);
    return;
  }

  const landlordPath = config.migrations.landlord;
  const tenantPath = config.migrations.tenant;
  const runLandlord = async () => {
    if (!landlordPath) return;
    console.log("Landlord migrations");
    const migrator = buildMigrator(config, connection, landlordPath, "landlord");
    await runMigratorCommand(command, migrator);
  };
  const runAllTenants = async () => {
    if (!tenantPath) return;
    if (!config.tenancy?.resolveTenant) {
      throw new Error("Tenant migrations require tenancy.resolveTenant() in bunny.config.ts.");
    }
    ConnectionManager.setTenantResolver(config.tenancy.resolveTenant);
    const tenantIds = await getTenantIds(config);
    for (const tenantId of tenantIds) {
      await runTenantMigrationCommand(command, config, tenantPath, tenantId);
    }
  };

  if (target.scope === "landlord") {
    await runLandlord();
    return;
  }
  if (target.scope === "tenant") {
    if (!tenantPath) return;
    if (!config.tenancy?.resolveTenant) {
      throw new Error("Tenant migrations require tenancy.resolveTenant() in bunny.config.ts.");
    }
    ConnectionManager.setTenantResolver(config.tenancy.resolveTenant);
    await runTenantMigrationCommand(command, config, tenantPath, target.tenantId);
    return;
  }
  if (target.scope === "tenants") {
    await runAllTenants();
    return;
  }

  if (command === "migrate:rollback") {
    await runAllTenants();
    await runLandlord();
    return;
  }
  await runLandlord();
  await runAllTenants();
}

async function createReplBootstrap(config: BunnyConfig, dir: string): Promise<string> {
  const bootstrapPath = join(dir, "bootstrap.ts");
  const modelRoots = normalizePathList(
    typeof config.modelsPath === "object" && !Array.isArray(config.modelsPath)
      ? ([config.modelsPath.landlord, config.modelsPath.tenant].filter(Boolean) as string[]).flat()
      : config.modelsPath || config.typeDeclarationModelsDir
  );
  const tsConfigPath = join(process.cwd(), "bunny.config.ts");
  const jsConfigPath = join(process.cwd(), "bunny.config.js");
  const configPath = existsSync(tsConfigPath) ? tsConfigPath : existsSync(jsConfigPath) ? jsConfigPath : null;
  const source = `
    import {
      BelongsTo,
      BelongsToMany,
      Blueprint,
      Builder,
      Collection,
      Connection,
      ConnectionManager,
      DB,
      Grammar,
      HasMany,
      HasManyThrough,
      HasOne,
      HasOneThrough,
      Migration,
      MigrationCreator,
      Migrator,
      MorphMany,
      MorphMap,
      MorphOne,
      MorphTo,
      MorphToMany,
      MySqlGrammar,
      ObserverRegistry,
      PostgresGrammar,
      Schema,
      SQLiteGrammar,
      TenantContext,
      TypeGenerator,
      TypeMapper,
      Model,
      RuleBuilder,
      ValidationError,
      Validator,
      collect,
      configureBunny,
      rule
    } from "@bunnykit/orm";
    import { existsSync } from "fs";
    import { readdir } from "fs/promises";
    import { basename, extname, join, resolve } from "path";
    import { pathToFileURL } from "url";

    const configPath = ${JSON.stringify(configPath)};
    const configModule = configPath ? await import(pathToFileURL(configPath).href) : null;
    const replConfig = configModule ? (configModule.default || configModule) : ${JSON.stringify(config)};
    const bunny = configureBunny(replConfig);
    const connection = bunny.connection;

    // The REPL is a single long-lived interactive session: idle gaps between
    // commands are expected and the user pins a tenant explicitly via
    // useTenant()/clearTenant(). The default idle-TTL + background sweep would
    // otherwise close the active tenant's pool out from under the prompt.
    ConnectionManager.disableTenantSweep();
    ConnectionManager.defaultTenantTtl = undefined;

    const modelRoots = ${JSON.stringify(modelRoots)};

    async function walkFiles(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        if (entry.name === "types") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...await walkFiles(fullPath));
          continue;
        }
        if (!entry.isFile()) continue;
        const name = entry.name;
        if (name.endsWith(".d.ts") || name.endsWith(".test.ts") || name.endsWith(".spec.ts")) continue;
        if (![".ts", ".js", ".mts", ".mjs", ".cts", ".cjs"].includes(extname(name))) continue;
        files.push(fullPath);
      }
      return files;
    }

    async function loadModels(roots) {
      const loaded = {};
      function registerModel(name, model) {
        if (!name || typeof model !== "function" || !(model.prototype instanceof Model)) return;
        loaded[name] = model;
        globalThis[name] = model;
      }
      for (const root of roots) {
        const resolvedRoot = resolve(process.cwd(), root);
        if (!existsSync(resolvedRoot)) continue;
        const files = await walkFiles(resolvedRoot);
        for (const file of files.sort()) {
          const mod = await import(pathToFileURL(file).href);
          for (const [exportName, exported] of Object.entries(mod)) {
            if (exportName === "default") continue;
            registerModel(exportName, exported);
          }
          if (typeof mod.default === "function" && mod.default.prototype instanceof Model) {
            const fileName = basename(file, extname(file));
            registerModel(fileName, mod.default);
            if (mod.default.name && mod.default.name !== fileName) {
              registerModel(mod.default.name, mod.default);
            }
          }
        }
      }
      globalThis.Models = loaded;
      return loaded;
    }

    const loadedModels = await loadModels(modelRoots);
    const originalTenantContextCurrent = TenantContext.current.bind(TenantContext);
    const originalDefaultConnection = connection;
    let activeTenantContext;

    function tenant() {
      return activeTenantContext;
    }

    async function clearTenant() {
      activeTenantContext = undefined;
      ConnectionManager.setDefault(originalDefaultConnection);
      Model.setConnection(originalDefaultConnection);
      return undefined;
    }

    async function useTenant(tenantId) {
      const resolved = await ConnectionManager.resolveTenant(tenantId);
      // Work on a shallow copy so we never mutate the object cached in
      // ConnectionManager.tenantCache (mutating schemaMode/connection there
      // would corrupt later TenantContext.run() resolutions for this tenant).
      const context = { ...resolved };
      let tenantConnection = context.connection;
      if (context.strategy === "schema" && context.schemaMode === "search_path" && context.schema) {
        // REPL doesn't wrap each query in a transaction, so search_path won't apply.
        // Create a connection with schema set directly (qualify mode) for REPL usage.
        tenantConnection = tenantConnection.withSchema(context.schema);
        context.connection = tenantConnection;
        context.schemaMode = "qualify";
      }
      // Pin the active REPL tenant so it cannot be expired/swept between
      // interactive commands even if a sweep is somehow re-enabled.
      context.expiresAt = undefined;
      activeTenantContext = context;
      // Set as default so Model.getConnection() picks up the tenant connection
      // even if TenantContext.current override doesn't propagate (e.g. module scope mismatch).
      ConnectionManager.setDefault(tenantConnection);
      Model.setConnection(tenantConnection);
      return context;
    }

    TenantContext.current = () => originalTenantContextCurrent() || activeTenantContext;

    Object.assign(globalThis, {
      Connection,
      Builder,
      Collection,
      ConnectionManager,
      DB,
      Blueprint,
      Grammar,
      SQLiteGrammar,
      MySqlGrammar,
      PostgresGrammar,
      Model,
      HasMany,
      BelongsTo,
      HasOne,
      HasManyThrough,
      HasOneThrough,
      BelongsToMany,
      MorphMap,
      MorphTo,
      MorphOne,
      MorphMany,
      MorphToMany,
      ObserverRegistry,
      Migration,
      Migrator,
      MigrationCreator,
      TypeGenerator,
      TypeMapper,
      RuleBuilder,
      Validator,
      ValidationError,
      rule,
      Schema,
      TenantContext,
      collect,
      configureBunny,
      db: connection,
      connection,
      bunny,
      config: replConfig,
      Models: loadedModels,
      useTenant,
      clearTenant,
      tenant,
    });

    console.log(\`Bunny REPL ready. Loaded \${Object.keys(loadedModels).length} model classes from modelsPath.\`);
  `;
  await writeFile(bootstrapPath, source, "utf-8");
  return bootstrapPath;
}

async function runRepl(config: BunnyConfig, replArgs: string[]): Promise<number> {
  const tmpRoot = resolveReplTmpRoot();
  await mkdir(tmpRoot, { recursive: true });
  await using tmpDir = await mkdtempDisposable(join(tmpRoot, "bunny-repl-"));
  const bootstrapPath = await createReplBootstrap(config, tmpDir.path);
  // The transpiler cache must outlive the disposable bootstrap dir so repeated
  // REPL sessions reuse it instead of transpiling the ORM from scratch.
  const cachePath = join(tmpRoot, "bunny-repl-cache");
  await mkdir(cachePath, { recursive: true });
  await using terminal = new Bun.Terminal({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    data(_terminal, data) {
      const text = Buffer.from(data).toString("binary");
      const rewritten = text.replace(/\x1b\[2K> /g, "\x1b[2Kbunny> ");
      process.stdout.write(Buffer.from(rewritten, "binary"));
    },
  });
  const proc = Bun.spawn(["bun", "repl", ...replArgs], {
    env: {
      ...process.env,
      TMPDIR: tmpDir.path,
      TEMP: tmpDir.path,
      TMP: tmpDir.path,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: cachePath,
    },
    terminal,
  });

  const stdin = process.stdin;
  const restoreRawMode = stdin.isTTY && typeof stdin.setRawMode === "function";

  if (restoreRawMode) {
    stdin.setRawMode(true);
  }
  stdin.resume();

  const onData = (chunk: Buffer) => {
    terminal.write(chunk);
  };
  stdin.on("data", onData);

  const cleanup = () => {
    stdin.off("data", onData);
    if (restoreRawMode) {
      stdin.setRawMode(false);
    }
  };

  const stop = () => terminal.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    terminal.write(`.load ${bootstrapPath}\n`);
    return await proc.exited;
  } finally {
    cleanup();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function loadConfig(allowFallback = false): Promise<BunnyConfig> {
  const configPath = join(process.cwd(), "bunny.config.ts");
  if (existsSync(configPath)) {
    const mod = await import(configPath);
    return mod.default || mod;
  }

  const jsConfigPath = join(process.cwd(), "bunny.config.js");
  if (existsSync(jsConfigPath)) {
    const mod = await import(jsConfigPath);
    return mod.default || mod;
  }

  // Fallback to environment variables
  const url = process.env.DATABASE_URL;
  if (url) {
    return {
      connection: { url },
      migrationsPath: parseEnvPathSetting(process.env.MIGRATIONS_PATH) || "./database/migrations",
      seedersPath: parseEnvPathSetting(process.env.SEEDERS_PATH),
      modelsPath: parseEnvPathSetting(process.env.MODELS_PATH),
    };
  }

  const driver = process.env.DB_CONNECTION as any;
  if (driver) {
    return {
      connection: {
        driver,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
        database: process.env.DB_DATABASE,
        username: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        filename: process.env.DB_DATABASE,
      },
      migrationsPath: parseEnvPathSetting(process.env.MIGRATIONS_PATH) || "./database/migrations",
      seedersPath: parseEnvPathSetting(process.env.SEEDERS_PATH),
      modelsPath: parseEnvPathSetting(process.env.MODELS_PATH),
    };
  }

  if (allowFallback) {
    return {
      connection: { url: "sqlite://:memory:" },
      migrationsPath: parseEnvPathSetting(process.env.MIGRATIONS_PATH) || "./database/migrations",
      seedersPath: parseEnvPathSetting(process.env.SEEDERS_PATH),
      modelsPath: parseEnvPathSetting(process.env.MODELS_PATH),
    };
  }

  throw new Error(
    "No database configuration found. Create bunny.config.ts or set DATABASE_URL / DB_CONNECTION environment variables."
  );
}

async function main() {
  const rawArgs = process.argv.slice(2);
  // `bunny run foo` is the documented spelling for application commands.
  // Keep direct `bunny foo` dispatch for backwards compatibility.
  const args    = rawArgs[0] === "run" ? rawArgs.slice(1) : rawArgs;
  const command = args[0];
  const isInit = command === "init";

  // Static metadata for built-in commands — shown before config loads
  const CORE_COMMANDS: Array<{ name: string; sig: string; desc: string }> = [
    { name: "migrate",          sig: "migrate {--landlord} {--tenants} {--tenant=}",              desc: "Run pending migrations" },
    { name: "migrate:rollback", sig: "migrate:rollback {--steps=} {--landlord} {--tenants} {--tenant=}", desc: "Rollback the last batch" },
    { name: "migrate:reset",    sig: "migrate:reset {--landlord} {--tenants} {--tenant=}",        desc: "Rollback all migrations" },
    { name: "migrate:refresh",  sig: "migrate:refresh {--landlord} {--tenants} {--tenant=}",      desc: "Reset and rerun all migrations" },
    { name: "migrate:fresh",    sig: "migrate:fresh {--landlord} {--tenants} {--tenant=}",        desc: "Drop all tables and rerun migrations" },
    { name: "migrate:status",   sig: "migrate:status {--landlord} {--tenants} {--tenant=}",       desc: "Show migration status" },
    { name: "make:migration",   sig: "make:migration {name} {--model} {--m} {--dir=} {--models-dir=}", desc: "Create a new migration file" },
    { name: "make:model",       sig: "make:model {name} {--migration} {--m} {--dir=}",           desc: "Create a new model file" },
    { name: "migrate:make",    sig: "migrate:make {name} {dir?}",                                desc: "Create a new migration file" },
    { name: "db:seed",          sig: "db:seed {seeder?} {--landlord} {--tenants} {--tenant=}",    desc: "Run database seeders" },
    { name: "schema:dump",      sig: "schema:dump {path?}",                                       desc: "Dump current schema to SQL" },
    { name: "schema:squash",    sig: "schema:squash {path?}",                                     desc: "Dump schema and mark migrations as run" },
    { name: "types:generate",   sig: "types:generate {dir?} {--landlord} {--tenant=}",            desc: "Generate TypeScript model types from DB schema" },
    { name: "queue:install",    sig: "queue:install {dir?} {--models=}",                          desc: "Generate the jobs and failed_jobs migration and optional models" },
    { name: "queue",            sig: "queue {--queue=} {--workers=}",                             desc: "Start the background job worker" },
    { name: "init",             sig: "init {--force} {-f}",                                       desc: "Create a bunny.config.ts file" },
    { name: "repl",             sig: "repl",                                                      desc: "Start an interactive REPL" },
  ];

  const isHelp    = args.includes("--help") || args.includes("-h");
  const isTopHelp = !command || command === "--help" || command === "-h";

  function printStaticHelp() {
    console.log("\nUsage: bunny <command> [options]\n");
    console.log(`Run ${styleText("yellow", "bunny <command> --help")} for command-specific usage.\n`);
    console.log("Core commands:\n");
    for (const { name, desc } of [...CORE_COMMANDS].sort((a, b) => a.name.localeCompare(b.name))) {
      const color = (name === "queue" || name === "repl") ? "green" : "yellow";
      console.log(`  ${styleText(color, name.padEnd(30))}${desc}`);
    }
    console.log("");
  }

  function printStaticCommandHelp(meta: (typeof CORE_COMMANDS)[number]) {
    console.log(`\n${styleText("bold", meta.desc)}\n`);
    console.log(`${styleText("bold", "Usage:")}  bunny ${styleText("yellow", meta.sig)}\n`);
    const tokens = meta.sig.match(/\{[^}]+\}/g) ?? [];
    const opts   = tokens.filter((t) => t.startsWith("{--"));
    if (opts.length > 0) {
      console.log(styleText("bold", "Options:"));
      for (const opt of opts) {
        const inner   = opt.slice(1, -1);
        const hasVal  = inner.endsWith("=");
        const optName = hasVal ? inner.slice(0, -1) : inner;
        const valHint = hasVal ? " <value>" : "";
        console.log(`  ${styleText("cyan", (optName + valHint).padEnd(28))}`);
      }
      console.log("");
    }
  }

  // These commands bypass CommandRunner, so handle their help before they
  // start an interactive or long-running process.
  if (isHelp && (command === "queue" || command === "repl")) {
    printStaticCommandHelp(CORE_COMMANDS.find((entry) => entry.name === command)!);
    return;
  }

  // REPL runs before configureBunny (uses in-memory SQLite fallback)
  if (command === "repl") {
    const config = await loadConfig(true);
    process.exit(await runRepl(config, args.slice(1)));
  }

  // Init runs before config loading.
  if (isInit) {
    process.exit(await runInitCommand(args.slice(1)));
  }

  // Load config — if it fails and the user asked for help, show static fallback
  let config: BunnyConfig;
  try {
    config = await loadConfig();
  } catch (err) {
    if (isTopHelp) { printStaticHelp(); return; }
    if (isHelp) {
      const meta = CORE_COMMANDS.find((c) => c.name === command);
      if (meta) { printStaticCommandHelp(meta); return; }
    }
    const missingConfig = err instanceof Error
      && err.message.includes("No database configuration found")
      && !hasLocalBunnyConfig();
    if (missingConfig) {
      console.error(styleText("red", "No bunny.config.ts found.", { stream: process.stderr }));
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const shouldInit = await promptYesNo("Initialize bunny.config.ts now?", true);
        if (shouldInit) {
          const code = await runInitCommand([]);
          if (code === 0) {
            console.log("Run your original command again after updating the config.");
          }
          process.exit(code);
        }
      }
      console.error("Run `bunny init` to create a starter config.");
      process.exit(1);
    }
    throw err;
  }

  const { connection } = configureBunny(config);
  registerOrmCommands(config, connection);

  // Walk user commandsPath and register user-defined commands
  for (const commandsPath of normalizePathList(config.commands?.commandsPath)) {
    const resolvedPath = resolve(process.cwd(), commandsPath);
    if (!existsSync(resolvedPath)) {
      console.warn(`[Commands] commandsPath not found: ${resolvedPath}`);
      continue;
    }
    for (const file of await walkJobFiles(resolvedPath)) {
      const mod = await import(pathToFileURL(file).href);
      for (const exported of Object.values(mod)) {
        if (
          typeof exported === "function" &&
          typeof (exported as any).signature === "string" &&
          typeof (exported as any).prototype?.handle === "function"
        ) {
          registerCommand(exported as any);
          continue;
        }
        if (
          typeof exported === "object" && exported !== null &&
          typeof (exported as any).signature === "string" &&
          typeof (exported as any).handle === "function"
        ) {
          registerCommand(exported as any);
        }
      }
    }
  }

  try {
    // Queue worker — long-running, stays hardcoded
    if (command === "queue") {
      const restArgs    = args.slice(1);
      const queueName   = getFlagValue(restArgs, "--queue") ?? config.queue?.defaultQueue ?? "default";
      const workerCount = parseInt(getFlagValue(restArgs, "--workers") ?? String(config.queue?.workers ?? 1), 10);

      let driver: QueueDriver;
      if (config.queue?.driver === "db" || !config.queue?.driver) {
        driver = new DatabaseQueueDriver(connection, {
          table: config.queue?.table,
          failedTable: config.queue?.failedTable,
        });
        await driver.migrate();
      } else if (config.queue?.driver === "redis") {
        driver = new RedisQueueDriver(redis, {
          prefix: config.cache?.prefix ? `${config.cache.prefix}queue:` : undefined,
        });
      } else if (typeof config.queue?.driver === "object" && "reserve" in config.queue.driver) {
        driver = config.queue.driver;
      } else {
        driver = new DatabaseQueueDriver(connection, {
          table: config.queue?.table,
          failedTable: config.queue?.failedTable,
        });
        await driver.migrate();
      }

      for (const jobsPath of normalizePathList(config.queue?.jobsPath)) {
        const resolvedPath = resolve(process.cwd(), jobsPath);
        if (!existsSync(resolvedPath)) {
          console.warn(`[Queue] jobsPath not found: ${resolvedPath}`);
          continue;
        }
        for (const file of await walkJobFiles(resolvedPath)) {
          const mod = await import(pathToFileURL(file).href);
          for (const exported of Object.values(mod)) {
            if (typeof exported === "function" && exported.prototype && typeof exported.prototype.handle === "function") {
              registerJob(exported as any);
            }
          }
        }
      }

      const worker = new Worker(driver, {
        queue: queueName,
        concurrency: workerCount,
        retryAfterSeconds: config.queue?.retryAfterSeconds,
        pollIntervalMs: config.queue?.pollIntervalMs,
      });
      console.log(`[Queue] Worker started. queue=${queueName} concurrency=${workerCount}`);
      const shutdown = () => { console.log("\n[Queue] Shutting down..."); worker.stop(); };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      await worker.run();
      console.log("[Queue] Worker stopped.");
      return;
    }

    // No command or --help: list all registered commands
    if (!command || command === "--help" || command === "-h") {
      const commands = listCommands().sort((a, b) => parseSignatureName(a.signature).localeCompare(parseSignatureName(b.signature)));
      console.log("\nUsage: bunny <command> [options]\n");
      if (commands.length === 0) {
        console.log("No commands registered.");
      } else {
        console.log("Available commands:\n");
        const allEntries = ([] as Array<[string, string]>).concat(
          commands.map((entry): [string, string] => [
            parseSignatureName(entry.signature),
            (isCommandConstructor(entry) ? entry.description : (entry as any).description) ?? "",
          ]),
          [["queue", "Start the background job worker"], ["repl", "Start an interactive REPL"]],
        ).sort(([a], [b]) => a.localeCompare(b));
        for (const [name, desc] of allEntries) {
          const color = (name === "queue" || name === "repl") ? "green" : "yellow";
          console.log(`  ${styleText(color, name.padEnd(30))}${desc}`);
        }
        console.log("");
      }
      return;
    }

    const entry = resolveCommand(command);
    if (!entry) {
      console.error(`${styleText("red", "Unknown command:", { stream: process.stderr })} ${command}`);
      console.error(`Run ${styleText("yellow", "bunny --help", { stream: process.stderr })} to list available commands.`);
      process.exit(1);
    }

    try {
      await new CommandRunner().run(entry, args.slice(1));
    } catch (err) {
      console.error(`${styleText("red", "Error:", { stream: process.stderr })} ${err instanceof Error ? err.message : String(err)}`);
      console.error(`\nRun ${styleText("yellow", `bunny ${command} --help`, { stream: process.stderr })} for usage.`);
      process.exit(1);
    }
  } finally {
    await ConnectionManager.closeAll();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
