import { Command } from "../commands/Command.js";
import { parseTargetFromOptions, runConfiguredMigrationCommand } from "./MigrationHelpers.js";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeMigrateCommand(config: BunnyConfig, connection: Connection) {
  return class extends Command.define("migrate {--landlord : Run on landlord connection} {--tenants : Run on all tenants} {--tenant= : Run on a specific tenant}") {
    static description = "Run pending migrations.";
    async handle() {
      await runConfiguredMigrationCommand("migrate", config, connection, parseTargetFromOptions(this));
    }
  };
}
