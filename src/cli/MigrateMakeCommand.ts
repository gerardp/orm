import { Command } from "../commands/Command.js";
import { MigrationCreator } from "../migration/MigrationCreator.js";
import { normalizePathList } from "../utils.js";
import { getDefaultMigrationsPath } from "./MigrationHelpers.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeMigrateMakeCommand(config: BunnyConfig) {
  return class extends Command.define("migrate:make {name} {dir?}") {
    static description = "Create a new migration file.";
    async handle() {
      const name = this.argument("name");
      const migrationRoots = normalizePathList(config.migrationsPath || config.migrations?.landlord);
      const dir = this.argumentOptional("dir")
        ?? migrationRoots[0]
        ?? String(getDefaultMigrationsPath(config));
      const creator = new MigrationCreator();
      const path = await creator.create(name, dir);
      this.info(`Created migration: ${path}`);
    }
  };
}
