import { Command } from "../commands/Command.js";
import { MigrationCreator } from "../migration/MigrationCreator.js";
import { normalizePathList } from "../utils.js";
import { getDefaultMigrationsPath, getModelPaths } from "./MigrationHelpers.js";
import { mkdir, writeFile, access } from "fs/promises";
import { join } from "path";
import type { BunnyConfig } from "../config/BunnyConfig.js";

const MIGRATION_STUB = `import { Migration, Schema } from "@bunnykit/orm";

export default class CreateQueueTables extends Migration {
  async up(): Promise<void> {
    await Schema.create("jobs", (table) => {
      table.bigIncrements("id");
      table.string("queue").index();
      table.string("job_class", 512);
      table.text("payload");
      table.smallInteger("attempts").unsigned();
      table.smallInteger("max_attempts").unsigned();
      table.integer("available_at").unsigned();
      table.integer("reserved_at").unsigned().nullable();
      table.integer("created_at").unsigned();
    });

    await Schema.create("failed_jobs", (table) => {
      table.bigIncrements("id");
      table.string("queue");
      table.string("job_class", 512);
      table.text("payload");
      table.text("exception");
      table.integer("failed_at").unsigned();
    });
  }

  async down(): Promise<void> {
    await Schema.dropIfExists("failed_jobs");
    await Schema.dropIfExists("jobs");
  }
}
`;

const JOB_MODEL_STUB = `import { Model } from "@bunnykit/orm";

interface JobAttributes {
  id: number;
  queue: string;
  job_class: string;
  payload: string;
  attempts: number;
  max_attempts: number;
  available_at: number;
  reserved_at: number | null;
  created_at: number;
}

export class Job extends Model.define<JobAttributes>("jobs") {
  static timestamps = false;
}
`;

const FAILED_JOB_MODEL_STUB = `import { Model } from "@bunnykit/orm";

interface FailedJobAttributes {
  id: number;
  queue: string;
  job_class: string;
  payload: string;
  exception: string;
  failed_at: number;
}

export class FailedJob extends Model.define<FailedJobAttributes>("failed_jobs") {
  static timestamps = false;
}
`;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

export function makeQueueInstallCommand(config: BunnyConfig) {
  return class extends Command.define("queue:install {dir? : Migration output directory} {--models= : Directory to create job models in}") {
    static description = "Generate the jobs and failed_jobs migration and optional models.";

    async handle() {
      const migrationRoots = normalizePathList(config.migrationsPath || config.migrations?.landlord);
      const migrationDir = this.argumentOptional("dir")
        ?? migrationRoots[0]
        ?? String(getDefaultMigrationsPath(config));

      // Migration
      const creator = new MigrationCreator();
      const migrationPath = await creator.createWithContent("create_queue_tables", migrationDir, MIGRATION_STUB);
      this.info(`Created migration: ${migrationPath}`);

      // Models — use --models flag, fall back to config modelsPath (landlord), skip if neither
      const { landlord } = getModelPaths(config);
      const modelsFlag   = this.option("models") as string | undefined;
      const modelsDir    = modelsFlag ?? (landlord ? normalizePathList(landlord)[0] : undefined);

      if (modelsDir) {
        await mkdir(modelsDir, { recursive: true });

        const jobPath = join(modelsDir, "Job.ts");
        if (await exists(jobPath)) {
          this.warn(`Skipped: ${jobPath} already exists`);
        } else {
          await writeFile(jobPath, JOB_MODEL_STUB, "utf-8");
          this.info(`Created model: ${jobPath}`);
        }

        const failedJobPath = join(modelsDir, "FailedJob.ts");
        if (await exists(failedJobPath)) {
          this.warn(`Skipped: ${failedJobPath} already exists`);
        } else {
          await writeFile(failedJobPath, FAILED_JOB_MODEL_STUB, "utf-8");
          this.info(`Created model: ${failedJobPath}`);
        }
      }
    }
  };
}
