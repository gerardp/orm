import type { QueueDriver } from "./QueueDriver.js";

export type JobConstructor = new (...args: any[]) => DispatchableJob;

export interface DispatchOptions {
  queue?: string;
  delay?: number;
  maxAttempts?: number;
}

let driver: QueueDriver | null = null;
let defaultQueue = "default";

export function setJobDriver(d: QueueDriver, queue: string): void {
  driver = d;
  defaultQueue = queue;
}

export function getJobDriver(): QueueDriver {
  if (!driver) throw new Error("Queue not configured. Call configureBunny() with a queue config first.");
  return driver;
}

export function getDefaultQueue(): string {
  return defaultQueue;
}

const registry = new Map<string, JobConstructor>();

export function registerJob(jobClass: JobConstructor): void {
  registry.set(jobClass.name, jobClass);
}

export function resolveJob(name: string): JobConstructor | undefined {
  return registry.get(name);
}

export abstract class DispatchableJob {
  static queue: string = "default";
  static maxAttempts: number = 3;
  static delay: number = 0;

  abstract handle(): Promise<void>;

  static async dispatch(this: JobConstructor & typeof DispatchableJob, ...args: any[]): Promise<void> {
    const d = getJobDriver();
    const queue = this.queue ?? defaultQueue;
    const maxAttempts = this.maxAttempts ?? 3;
    const delay = this.delay ?? 0;
    const payload = JSON.stringify({ args });
    await d.dispatch(queue, this.name, payload, delay, maxAttempts);
  }
}
