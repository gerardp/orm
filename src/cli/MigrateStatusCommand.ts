import { Command } from "../commands/Command.js";
import { parseTargetFromOptions, runConfiguredMigrationCommand } from "./MigrationHelpers.js";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeMigrateStatusCommand(config: BunnyConfig, connection: Connection) {
  return class extends Command.define("migrate:status {--landlord : Run on landlord connection} {--tenants : Run on all tenants} {--tenant= : Run on a specific tenant}") {
    static description = "Show the status of all migrations.";
    async handle() {
      await runConfiguredMigrationCommand("migrate:status", config, connection, parseTargetFromOptions(this));
    }
  };
}
