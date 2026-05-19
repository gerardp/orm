import type { QueueDriver } from "./QueueDriver.js";
import { setJobDriver, getJobDriver, getDefaultQueue, type JobConstructor, type DispatchOptions } from "./Job.js";

export class Queue {
  static configure(driver: QueueDriver, defaultQueue = "default"): void {
    setJobDriver(driver, defaultQueue);
  }

  static async dispatch(jobClass: JobConstructor, args: any[], options: DispatchOptions = {}): Promise<void> {
    const d = getJobDriver();
    const queue = options.queue ?? (jobClass as any).queue ?? getDefaultQueue();
    const delay = options.delay ?? (jobClass as any).delay ?? 0;
    const maxAttempts = options.maxAttempts ?? (jobClass as any).maxAttempts ?? 3;
    const payload = JSON.stringify({ args });
    await d.dispatch(queue, jobClass.name, payload, delay, maxAttempts);
  }

  static async size(queue?: string): Promise<number> {
    return getJobDriver().size(queue);
  }

  static getDriver(): QueueDriver {
    return getJobDriver();
  }
}
