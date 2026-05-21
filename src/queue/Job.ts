import type { QueueDriver } from "./QueueDriver.js";
import { TenantContext } from "../connection/TenantContext.js";

export interface JobStatics {
  queue: string;
  maxAttempts: number;
  delay: number;
  name: string;
}

export type JobConstructor = (new (...args: any[]) => DispatchableJob) & JobStatics;

export interface DispatchOptions {
  queue?: string;
  delay?: number;
  maxAttempts?: number;
  /**
   * Name of a previously-registered driver to dispatch to. Omit to use the
   * default driver. Register additional drivers via `Queue.registerDriver()`.
   */
  connection?: string;
}

let driver: QueueDriver | null = null;
let defaultQueue = "default";
const drivers = new Map<string, QueueDriver>();

export function setJobDriver(d: QueueDriver, queue: string): void {
  driver = d;
  defaultQueue = queue;
  drivers.set("default", d);
}

export function registerJobDriver(name: string, d: QueueDriver): void {
  drivers.set(name, d);
}

export function getJobDriver(): QueueDriver {
  if (!driver) throw new Error("Queue not configured. Call configureBunny() with a queue config first.");
  return driver;
}

export function getJobDriverByConnection(name?: string): QueueDriver {
  if (!name) return getJobDriver();
  const d = drivers.get(name);
  if (!d) throw new Error(`Queue connection "${name}" not registered. Call Queue.registerDriver("${name}", driver) first.`);
  return d;
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

  readonly _jobArgs: any[];

  constructor(...args: any[]) {
    this._jobArgs = args;
  }

  abstract handle(): Promise<void>;

  static async dispatch(this: JobConstructor & typeof DispatchableJob, ...args: any[]): Promise<void> {
    const d = getJobDriver();
    const queue = this.queue ?? defaultQueue;
    const maxAttempts = this.maxAttempts ?? 3;
    const delay = this.delay ?? 0;
    const tenantId = TenantContext.current()?.tenantId;
    const payload = JSON.stringify({ args, tenantId });
    await TenantContext.asLandlord(() => d.dispatch(queue, this.name, payload, delay, maxAttempts));
  }
}

export { drivers as _registeredDrivers };
