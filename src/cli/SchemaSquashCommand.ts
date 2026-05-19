import { Command } from "../commands/Command.js";
import { buildMigrator, getDefaultMigrationsPath } from "./MigrationHelpers.js";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeSchemaSquashCommand(config: BunnyConfig, connection: Connection) {
  return class extends Command.define("schema:squash {path?}") {
    static description = "Dump the schema and mark all migrations as run.";
    async handle() {
      const outputPath = this.argumentOptional("path") ?? "./database/schema.sql";
      const migrator   = buildMigrator(config, connection, getDefaultMigrationsPath(config), "landlord");
      await migrator.squash(outputPath);
      this.info(`Schema squashed to ${outputPath}`);
    }
  };
}
