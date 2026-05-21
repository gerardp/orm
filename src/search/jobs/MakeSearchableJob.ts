import { DispatchableJob, registerJob } from "../../queue/Job.js";
import { getSearchEngine } from "../SearchManager.js";
import type { SearchableRecord } from "../SearchEngine.js";

export class MakeSearchableJob extends DispatchableJob {
  static queue = "default";
  static maxAttempts = 3;

  constructor(public readonly record: SearchableRecord) {
    super(record);
  }

  async handle(): Promise<void> {
    await getSearchEngine().update([this.record]);
  }
}

registerJob(MakeSearchableJob as any);
