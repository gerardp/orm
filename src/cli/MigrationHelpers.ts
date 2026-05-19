import { ConnectionManager } from "../connection/ConnectionManager.js";
import { TenantContext } from "../connection/TenantContext.js";
import { Migrator } from "../migration/Migrator.js";
import { SeederRunner } from "../seeding/Seeder.js";
import { normalizePathList } from "../utils.js";
import { resolve, sep } from "path";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig, ModelsPath } from "../config/BunnyConfig.js";
import type { MigratorOptions } from "../migration/Migrator.js";

export type MigrationCommand =
  | "migrate"
  | "migrate:rollback"
  | "migrate:status"
  | "migrate:reset"
  | "migrate:refresh"
  | "migrate:fresh";

export type MigrationTarget =
  | { scope: "default" }
  | { scope: "landlord" }
  | { scope: "tenants" }
  | { scope: "tenant"; tenantId: string };

/** Read migration target from a command's options (--landlord / --tenants / --tenant=) */
export function parseTargetFromOptions(cmd: {
  option(name: string): string | boolean | undefined;
}): MigrationTarget {
  if (cmd.option("landlord")) return { scope: "landlord" };
  if (cmd.option("tenants"))  return { scope: "tenants" };
  const tenant = cmd.option("tenant");
  if (tenant && typeof tenant === "string") return { scope: "tenant", tenantId: tenant };
  return { scope: "default" };
}

export function getDefaultMigrationsPath(config: BunnyConfig): string | string[] {
  return config.migrationsPath || config.migrations?.landlord || "./database/migrations";
}

export function getModelPaths(config: BunnyConfig): { landlord?: string | string[]; tenant?: string | string[] } {
  const mp = config.modelsPath;
  if (mp && typeof mp === "object" && !Array.isArray(mp)) return mp as ModelsPath;
  return { landlord: mp as string | string[] | undefined, tenant: mp as string | string[] | undefined };
}

export function getScopeExclusions(
  ourModels: string | string[] | undefined,
  otherModels: string | string[] | undefined,
): string[] | undefined {
  if (!ourModels || !otherModels) return undefined;
  const ourRoots   = normalizePathList(ourModels).map((r) => resolve(process.cwd(), r));
  const otherRoots = normalizePathList(otherModels).map((r) => resolve(process.cwd(), r));
  return otherRoots.filter((other) =>
    ourRoots.some((our) => other.startsWith(our + sep) || other === our),
  );
}

export function createTypeGeneratorOptions(config: BunnyConfig, modelsPathOverride?: string | string[]) {
  const modelRoots = normalizePathList(
    modelsPathOverride ??
    (typeof config.modelsPath === "string" || Array.isArray(config.modelsPath) ? config.modelsPath : undefined) ??
    config.typeDeclarationModelsDir,
  );
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

export function createMigrationOptions(config: BunnyConfig) {
  return { createIfMissing: config.migrations?.createIfMissing };
}

export function buildMigrator(
  config: BunnyConfig,
  connection: Connection,
  path: string | string[],
  scope: "landlord" | "tenant",
  extraOptions: Partial<MigratorOptions> = {},
): Migrator {
  return new Migrator(
    connection,
    path,
    config.typesOutDir,
    createTypeGeneratorOptions(config, getModelPaths(config)[scope]),
    { ...createMigrationOptions(config), ...extraOptions },
  );
}

export async function runMigratorCommand(
  command: MigrationCommand,
  migrator: Migrator,
  statusLabel?: string,
): Promise<void> {
  if (command === "migrate")           { await migrator.run();      return; }
  if (command === "migrate:rollback")  { await migrator.rollback(); return; }
  if (command === "migrate:reset")     { await migrator.reset();    return; }
  if (command === "migrate:refresh")   { await migrator.refresh();  return; }
  if (command === "migrate:fresh")     { await migrator.fresh();    return; }
  const status = await migrator.status();
  if (statusLabel) console.log(statusLabel);
  console.table(status);
}

export async function getTenantIds(config: BunnyConfig): Promise<string[]> {
  if (!config.tenancy?.listTenants) {
    throw new Error("Tenant migrations require tenancy.listTenants() in bunny.config.ts.");
  }
  return (await config.tenancy.listTenants()).map(String);
}

export async function runTenantMigrator(
  command: MigrationCommand,
  config: BunnyConfig,
  connectionPath: string | string[],
  tenantId: string,
  typesOutDir?: string,
): Promise<void> {
  await TenantContext.run(tenantId, async () => {
    const context = TenantContext.current();
    if (!context) throw new Error(`Tenant "${tenantId}" did not resolve to an active context.`);
    console.log(`Tenant: ${tenantId}`);
    const migrator = buildMigrator(
      typesOutDir ? { ...config, typesOutDir } : config,
      context.connection,
      connectionPath,
      "tenant",
      { tenantId },
    );
    await runMigratorCommand(command, migrator);
  });
}

export async function runTenantMigrationCommand(
  command: MigrationCommand,
  config: BunnyConfig,
  tenantPath: string | string[],
  tenantId: string,
  typesOutDir?: string,
): Promise<void> {
  try {
    await runTenantMigrator(command, config, tenantPath, tenantId, typesOutDir);
  } finally {
    await ConnectionManager.closeTenant(tenantId);
  }
}

export async function runConfiguredMigrationCommand(
  command: MigrationCommand,
  config: BunnyConfig,
  connection: Connection,
  target: MigrationTarget,
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
      for (const tenantId of await getTenantIds(config)) {
        await runTenantMigrationCommand(command, config, defaultPath, tenantId, config.typesOutDir);
      }
      return;
    }
    await runMigratorCommand(command, buildMigrator(config, connection, defaultPath, "landlord"));
    return;
  }

  const landlordPath = config.migrations.landlord;
  const tenantPath   = config.migrations.tenant;

  const runLandlord = async () => {
    if (!landlordPath) return;
    console.log("Landlord migrations");
    await runMigratorCommand(command, buildMigrator(config, connection, landlordPath, "landlord"));
  };

  const runAllTenants = async () => {
    if (!tenantPath) return;
    if (!config.tenancy?.resolveTenant) {
      throw new Error("Tenant migrations require tenancy.resolveTenant() in bunny.config.ts.");
    }
    ConnectionManager.setTenantResolver(config.tenancy.resolveTenant);
    for (const tenantId of await getTenantIds(config)) {
      await runTenantMigrationCommand(command, config, tenantPath, tenantId);
    }
  };

  if (target.scope === "landlord") { await runLandlord(); return; }
  if (target.scope === "tenants")  { await runAllTenants(); return; }
  if (target.scope === "tenant") {
    if (!tenantPath) return;
    if (!config.tenancy?.resolveTenant) {
      throw new Error("Tenant migrations require tenancy.resolveTenant() in bunny.config.ts.");
    }
    ConnectionManager.setTenantResolver(config.tenancy.resolveTenant);
    await runTenantMigrationCommand(command, config, tenantPath, target.tenantId);
    return;
  }

  // default: landlord first, then tenants (rollback reverses order)
  if (command === "migrate:rollback") {
    await runAllTenants();
    await runLandlord();
  } else {
    await runLandlord();
    await runAllTenants();
  }
}

export async function runSeederCommand(
  config: BunnyConfig,
  connection: Connection,
  scope: MigrationTarget,
  target?: string,
): Promise<void> {
  const seederPath = config.seedersPath || "./database/seeders";
  const runner = new SeederRunner(connection);

  const runDefault = async () => {
    if (target) { await runner.runTarget(target, seederPath); return; }
    await runner.runPaths(seederPath);
  };

  if (scope.scope === "default" || scope.scope === "landlord") { await runDefault(); return; }

  if (!config.tenancy?.resolveTenant) {
    throw new Error("Tenant seeding requires tenancy.resolveTenant() in bunny.config.ts.");
  }
  ConnectionManager.setTenantResolver(config.tenancy.resolveTenant);

  if (scope.scope === "tenant") {
    await TenantContext.run(scope.tenantId, runDefault);
    return;
  }

  for (const tenantId of await getTenantIds(config)) {
    await TenantContext.run(tenantId, runDefault);
  }
}
