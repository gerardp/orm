import { Command } from "../commands/Command.js";
import { parseTargetFromOptions, runConfiguredMigrationCommand } from "./MigrationHelpers.js";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeMigrateFreshCommand(config: BunnyConfig, connection: Connection) {
  return class extends Command.define("migrate:fresh {--landlord : Run on landlord connection} {--tenants : Run on all tenants} {--tenant= : Run on a specific tenant} {--types : Generate types after migration}") {
    static description = "Drop all tables and rerun all migrations.";
    async handle() {
      await runConfiguredMigrationCommand("migrate:fresh", config, connection, parseTargetFromOptions(this), !!this.option("types"));
    }
  };
}
