import { Command } from "../commands/Command.js";
import { parseTargetFromOptions, runConfiguredMigrationCommand } from "./MigrationHelpers.js";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeMigrateRollbackCommand(config: BunnyConfig, connection: Connection) {
  return class extends Command.define("migrate:rollback {--landlord : Run on landlord connection} {--tenants : Run on all tenants} {--tenant= : Run on a specific tenant}") {
    static description = "Rollback the last batch of migrations.";
    async handle() {
      await runConfiguredMigrationCommand("migrate:rollback", config, connection, parseTargetFromOptions(this));
    }
  };
}
