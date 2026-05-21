import { DispatchableJob, registerJob } from "../../queue/Job.js";
import { getSearchEngine } from "../SearchManager.js";
import type { SearchableRecord } from "../SearchEngine.js";

export class RemoveFromSearchJob extends DispatchableJob {
  static queue = "default";
  static maxAttempts = 3;

  constructor(public readonly record: SearchableRecord) {
    super(record);
  }

  async handle(): Promise<void> {
    await getSearchEngine().delete([this.record]);
  }
}

registerJob(RemoveFromSearchJob as any);
