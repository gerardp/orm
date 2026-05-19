import { Command } from "../commands/Command.js";
import { buildMigrator, getDefaultMigrationsPath } from "./MigrationHelpers.js";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeSchemaDumpCommand(config: BunnyConfig, connection: Connection) {
  return class extends Command.define("schema:dump {path?}") {
    static description = "Dump the current database schema to a SQL file.";
    async handle() {
      const outputPath = this.argumentOptional("path") ?? "./database/schema.sql";
      const migrator   = buildMigrator(config, connection, getDefaultMigrationsPath(config), "landlord");
      await migrator.dumpSchema(outputPath);
      this.info(`Schema dumped to ${outputPath}`);
    }
  };
}
