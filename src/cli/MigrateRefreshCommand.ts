import { Command } from "../commands/Command.js";
import { parseTargetFromOptions, runConfiguredMigrationCommand } from "./MigrationHelpers.js";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeMigrateRefreshCommand(config: BunnyConfig, connection: Connection) {
  return class extends Command.define("migrate:refresh {--landlord} {--tenants} {--tenant=}") {
    static description = "Reset and rerun all migrations.";
    async handle() {
      await runConfiguredMigrationCommand("migrate:refresh", config, connection, parseTargetFromOptions(this));
    }
  };
}
