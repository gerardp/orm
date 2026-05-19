import type { QueueDriver, JobRecord } from "./QueueDriver.js";
import { resolveJob } from "./Job.js";

export interface WorkerOptions {
  queue?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  retryAfterSeconds?: number;
  retryDelaySeconds?: number;
}

export class Worker {
  private queue: string;
  private concurrency: number;
  private pollIntervalMs: number;
  private retryAfterSeconds: number;
  private retryDelaySeconds: number;
  private running = false;
  private activeJobs = 0;
  private stopSignal = false;

  constructor(private driver: QueueDriver, options: WorkerOptions = {}) {
    this.queue = options.queue ?? "default";
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 90;
    this.retryDelaySeconds = options.retryDelaySeconds ?? 0;
  }

  async run(): Promise<void> {
    this.running = true;
    this.stopSignal = false;

    const loops = Array.from({ length: this.concurrency }, () => this.workerLoop());
    await Promise.all(loops);
    this.running = false;
  }

  stop(): void {
    this.stopSignal = true;
  }

  private async workerLoop(): Promise<void> {
    while (!this.stopSignal) {
      const job = await this.driver.reserve(this.queue, this.retryAfterSeconds);

      if (!job) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      this.activeJobs++;
      try {
        await this.processJob(job);
      } finally {
        this.activeJobs--;
      }
    }

    // Drain: wait until active jobs finish (for the parallel loop case, each
    // loop handles its own active job, so just returning is enough).
  }

  private async processJob(job: JobRecord): Promise<void> {
    const JobClass = resolveJob(job.jobClass);

    if (!JobClass) {
      const err = new Error(`Unknown job class: ${job.jobClass}. Register it via registerJob() or set jobsPath in config.`);
      console.error(`[Queue] ${err.message}`);
      await this.driver.fail(job.id, err.stack ?? err.message);
      return;
    }

    let payload: { args: any[] };
    try {
      payload = JSON.parse(job.payload);
    } catch {
      await this.driver.fail(job.id, `Invalid payload JSON for job ${job.jobClass}`);
      return;
    }

    const instance = new JobClass(...(payload.args ?? []));

    try {
      await instance.handle();
      await this.driver.complete(job.id);
      console.log(`[Queue] Processed ${job.jobClass} (id=${job.id})`);
    } catch (err: any) {
      const message = err?.stack ?? String(err);
      const attempts = job.attempts;
      const maxAttempts = job.maxAttempts;

      if (attempts >= maxAttempts) {
        await this.driver.fail(job.id, message);
        console.error(`[Queue] Failed ${job.jobClass} (id=${job.id}) after ${attempts} attempt(s): ${err?.message ?? err}`);
      } else {
        await this.driver.release(job.id, this.retryDelaySeconds);
        console.warn(`[Queue] Retrying ${job.jobClass} (id=${job.id}) attempt ${attempts}/${maxAttempts}: ${err?.message ?? err}`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
