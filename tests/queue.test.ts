import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Connection } from "../src/connection/Connection.js";
import { ConnectionManager } from "../src/connection/ConnectionManager.js";
import { DatabaseQueueDriver } from "../src/queue/DatabaseQueueDriver.js";
import { Queue } from "../src/queue/Queue.js";
import { DispatchableJob, registerJob, resolveJob } from "../src/queue/Job.js";
import { Worker } from "../src/queue/Worker.js";

function makeConnection(): Connection {
  return new Connection({ url: "sqlite://:memory:" });
}

describe("DatabaseQueueDriver", () => {
  let conn: Connection;
  let driver: DatabaseQueueDriver;

  beforeEach(async () => {
    conn = makeConnection();
    driver = new DatabaseQueueDriver(conn);
    await driver.migrate();
  });

  afterEach(async () => {
    await conn.close();
  });

  it("dispatches and reserves a job", async () => {
    await driver.dispatch("default", "SendEmail", JSON.stringify({ args: ["user@example.com"] }), 0, 3);

    const job = await driver.reserve("default", 90);
    expect(job).not.toBeNull();
    expect(job!.jobClass).toBe("SendEmail");
    expect(job!.attempts).toBe(1);
    expect(job!.queue).toBe("default");
  });

  it("returns null when queue is empty", async () => {
    const job = await driver.reserve("default", 90);
    expect(job).toBeNull();
  });

  it("does not reserve same job twice", async () => {
    await driver.dispatch("default", "SendEmail", "{}", 0, 3);
    const job1 = await driver.reserve("default", 90);
    const job2 = await driver.reserve("default", 90);
    expect(job1).not.toBeNull();
    expect(job2).toBeNull();
  });

  it("completes a job (removes from table)", async () => {
    await driver.dispatch("default", "SendEmail", "{}", 0, 3);
    const job = await driver.reserve("default", 90);
    await driver.complete(job!.id);
    expect(await driver.size("default")).toBe(0);
  });

  it("fails a job (moves to failed_jobs)", async () => {
    await driver.dispatch("default", "SendEmail", "{}", 0, 3);
    const job = await driver.reserve("default", 90);
    await driver.fail(job!.id, "Error: SMTP timeout");
    expect(await driver.size("default")).toBe(0);
    const failed = await conn.query<any>("SELECT * FROM failed_jobs");
    expect(failed).toHaveLength(1);
    expect(failed[0].job_class).toBe("SendEmail");
    expect(failed[0].exception).toContain("SMTP timeout");
  });

  it("releases a job back to queue with delay", async () => {
    const now = Math.floor(Date.now() / 1000);
    await driver.dispatch("default", "SendEmail", "{}", 0, 3);
    const job = await driver.reserve("default", 90);
    await driver.release(job!.id, 60);

    // Not available yet (delay=60)
    const notYet = await driver.reserve("default", 90);
    expect(notYet).toBeNull();
    expect(await driver.size("default")).toBe(1);
  });

  it("re-reserves expired reserved jobs", async () => {
    await driver.dispatch("default", "SendEmail", "{}", 0, 3);
    // Reserve and manually set reserved_at to 200s ago to simulate timeout
    const job = await driver.reserve("default", 90);
    const expiredAt = Math.floor(Date.now() / 1000) - 200;
    await conn.run("UPDATE jobs SET reserved_at = ? WHERE id = ?", [expiredAt, job!.id]);

    // Should now be re-reservable
    const reReserved = await driver.reserve("default", 90);
    expect(reReserved).not.toBeNull();
    expect(reReserved!.id).toBe(job!.id);
  });

  it("respects named queues", async () => {
    await driver.dispatch("emails", "SendEmail", "{}", 0, 3);
    await driver.dispatch("reports", "GenerateReport", "{}", 0, 3);

    const emailJob = await driver.reserve("emails", 90);
    const reportJob = await driver.reserve("reports", 90);
    expect(emailJob?.jobClass).toBe("SendEmail");
    expect(reportJob?.jobClass).toBe("GenerateReport");
  });

  it("respects dispatch delay", async () => {
    await driver.dispatch("default", "SendEmail", "{}", 60, 3);
    const job = await driver.reserve("default", 90);
    expect(job).toBeNull();
  });

  it("counts queue size", async () => {
    await driver.dispatch("default", "A", "{}", 0, 3);
    await driver.dispatch("default", "B", "{}", 0, 3);
    await driver.dispatch("other", "C", "{}", 0, 3);
    expect(await driver.size("default")).toBe(2);
    expect(await driver.size("other")).toBe(1);
    expect(await driver.size()).toBe(3);
  });

  it("respects maxAttempts stored in record", async () => {
    await driver.dispatch("default", "SendEmail", "{}", 0, 5);
    const job = await driver.reserve("default", 90);
    expect(job!.maxAttempts).toBe(5);
  });
});

describe("DispatchableJob", () => {
  let conn: Connection;
  let driver: DatabaseQueueDriver;

  beforeEach(async () => {
    conn = makeConnection();
    driver = new DatabaseQueueDriver(conn);
    await driver.migrate();
    Queue.configure(driver, "default");
  });

  afterEach(async () => {
    await conn.close();
  });

  it("serializes constructor args on dispatch", async () => {
    class SendEmail extends DispatchableJob {
      constructor(public to: string, public subject: string) { super(to, subject); }
      async handle() {}
    }
    registerJob(SendEmail);

    await SendEmail.dispatch("a@b.com", "Hello");
    const job = await driver.reserve("default", 90);
    expect(job).not.toBeNull();
    const payload = JSON.parse(job!.payload);
    expect(payload.args).toEqual(["a@b.com", "Hello"]);
  });

  it("uses static queue override", async () => {
    class ReportJob extends DispatchableJob {
      static override queue = "reports";
      async handle() {}
    }
    registerJob(ReportJob);

    await ReportJob.dispatch();
    expect(await driver.size("reports")).toBe(1);
    expect(await driver.size("default")).toBe(0);
  });

  it("uses static maxAttempts", async () => {
    class FragileJob extends DispatchableJob {
      static override maxAttempts = 1;
      async handle() {}
    }
    registerJob(FragileJob);

    await FragileJob.dispatch();
    const job = await driver.reserve("default", 90);
    expect(job!.maxAttempts).toBe(1);
  });

  it("Queue.dispatch() facade works", async () => {
    class PingJob extends DispatchableJob {
      async handle() {}
    }
    registerJob(PingJob);

    await Queue.dispatch(PingJob, []);
    expect(await driver.size("default")).toBe(1);
  });

  it("Queue.dispatch() respects options", async () => {
    class PingJob extends DispatchableJob {
      async handle() {}
    }
    registerJob(PingJob);

    await Queue.dispatch(PingJob, [], { queue: "critical", maxAttempts: 5 });
    expect(await driver.size("critical")).toBe(1);
    const job = await driver.reserve("critical", 90);
    expect(job!.maxAttempts).toBe(5);
  });

  it("resolveJob returns registered class", () => {
    class MyJob extends DispatchableJob {
      async handle() {}
    }
    registerJob(MyJob);
    expect(resolveJob("MyJob")).toBe(MyJob);
  });

  it("Queue.dispatch() accepts an instance", async () => {
    class SendEmail extends DispatchableJob {
      constructor(public to: string) { super(to); }
      async handle() {}
    }
    registerJob(SendEmail);

    await Queue.dispatch(new SendEmail("a@b.com"));
    const job = await driver.reserve("default", 90);
    expect(job).not.toBeNull();
    expect(job!.jobClass).toBe("SendEmail");
    expect(JSON.parse(job!.payload).args).toEqual(["a@b.com"]);
  });

  it("Queue.dispatch() instance uses static queue from class", async () => {
    class CriticalJob extends DispatchableJob {
      static override queue = "critical";
      constructor(public x: number) { super(x); }
      async handle() {}
    }
    registerJob(CriticalJob);

    await Queue.dispatch(new CriticalJob(42));
    expect(await driver.size("critical")).toBe(1);
    const job = await driver.reserve("critical", 90);
    expect(JSON.parse(job!.payload).args).toEqual([42]);
  });

  it("Queue.dispatch() instance options override static values", async () => {
    class FlexJob extends DispatchableJob {
      static override queue = "low";
      constructor(public n: number) { super(n); }
      async handle() {}
    }
    registerJob(FlexJob);

    await Queue.dispatch(new FlexJob(1), { queue: "high", maxAttempts: 5 });
    expect(await driver.size("high")).toBe(1);
    const job = await driver.reserve("high", 90);
    expect(job!.maxAttempts).toBe(5);
  });
});

describe("Worker", () => {
  let conn: Connection;
  let driver: DatabaseQueueDriver;

  beforeEach(async () => {
    conn = makeConnection();
    driver = new DatabaseQueueDriver(conn);
    await driver.migrate();
    Queue.configure(driver, "default");
  });

  afterEach(async () => {
    await conn.close();
  });

  it("processes a job and completes it", async () => {
    const handled: string[] = [];

    class GreetJob extends DispatchableJob {
      constructor(public name: string) { super(name); }
      async handle() { handled.push(this.name); }
    }
    registerJob(GreetJob);

    await GreetJob.dispatch("World");

    const worker = new Worker(driver, { pollIntervalMs: 10 });
    // Run one tick then stop
    const runPromise = worker.run();
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    await runPromise;

    expect(handled).toEqual(["World"]);
    expect(await driver.size("default")).toBe(0);
  });

  it("retries a job on failure when under maxAttempts", async () => {
    let callCount = 0;

    class FlakyJob extends DispatchableJob {
      static override maxAttempts = 3;
      async handle() {
        callCount++;
        if (callCount < 2) throw new Error("transient");
      }
    }
    registerJob(FlakyJob);

    await FlakyJob.dispatch();

    const worker = new Worker(driver, { pollIntervalMs: 10, retryAfterSeconds: 0 });
    const runPromise = worker.run();
    await new Promise((r) => setTimeout(r, 150));
    worker.stop();
    await runPromise;

    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("moves job to failed_jobs after exhausting maxAttempts", async () => {
    class AlwaysFailJob extends DispatchableJob {
      static override maxAttempts = 1;
      async handle() { throw new Error("always fails"); }
    }
    registerJob(AlwaysFailJob);

    await AlwaysFailJob.dispatch();

    const worker = new Worker(driver, { pollIntervalMs: 10 });
    const runPromise = worker.run();
    await new Promise((r) => setTimeout(r, 100));
    worker.stop();
    await runPromise;

    expect(await driver.size("default")).toBe(0);
    const failed = await conn.query<any>("SELECT * FROM failed_jobs");
    expect(failed).toHaveLength(1);
    expect(failed[0].job_class).toBe("AlwaysFailJob");
  });

  it("fails job with unknown class", async () => {
    await driver.dispatch("default", "GhostJob", "{}", 0, 1);

    const worker = new Worker(driver, { pollIntervalMs: 10 });
    const runPromise = worker.run();
    await new Promise((r) => setTimeout(r, 100));
    worker.stop();
    await runPromise;

    expect(await driver.size("default")).toBe(0);
    const failed = await conn.query<any>("SELECT * FROM failed_jobs");
    expect(failed).toHaveLength(1);
  });
});
