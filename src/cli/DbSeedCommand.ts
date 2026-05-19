import { Command } from "../commands/Command.js";
import { parseTargetFromOptions, runSeederCommand } from "./MigrationHelpers.js";
import type { Connection } from "../connection/Connection.js";
import type { BunnyConfig } from "../config/BunnyConfig.js";

export function makeDbSeedCommand(config: BunnyConfig, connection: Connection) {
  return class extends Command.define("db:seed {seeder? : Seeder class name to run} {--landlord : Run on landlord connection} {--tenants : Run on all tenants} {--tenant= : Run on a specific tenant}") {
    static description = "Run database seeders.";
    async handle() {
      const seeder = this.argumentOptional("seeder");
      const scope  = parseTargetFromOptions(this);
      await runSeederCommand(config, connection, scope, seeder);
    }
  };
}
