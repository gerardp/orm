import { Command } from "../commands/Command.js";
import { parseTargetFromOptions, runSeederCommand } from "./MigrationHelpers.js";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeDbSeedCommand(config: BunnyConfig, connection: Connection) {
  return class extends Command.define("db:seed {seeder?} {--landlord} {--tenants} {--tenant=}") {
    static description = "Run database seeders.";
    async handle() {
      const seeder = this.argumentOptional("seeder");
      const scope  = parseTargetFromOptions(this);
      await runSeederCommand(config, connection, scope, seeder);
    }
  };
}
