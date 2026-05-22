import type { Connection } from "../connection/Connection.js";
import type { JobRecord, QueueDriver } from "./QueueDriver.js";

export interface DatabaseQueueDriverOptions {
  table?: string;
  failedTable?: string;
}

interface RawJobRow {
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

function toJobRecord(row: RawJobRow): JobRecord {
  return {
    id: row.id,
    queue: row.queue,
    jobClass: row.job_class,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    reservedAt: row.reserved_at,
    createdAt: row.created_at,
  };
}

export class DatabaseQueueDriver implements QueueDriver {
  private table: string;
  private failedTable: string;
  private sqliteMutex: Promise<void> = Promise.resolve();

  constructor(private connection: Connection, options: DatabaseQueueDriverOptions = {}) {
    this.table = options.table ?? "jobs";
    this.failedTable = options.failedTable ?? "failed_jobs";
  }

  private async withSqliteMutex<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.sqliteMutex;
    let release!: () => void;
    this.sqliteMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async migrate(): Promise<void> {
    const driver = this.connection.getDriverName();
    const t = this.table;
    const f = this.failedTable;

    if (driver === "sqlite") {
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS ${t} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          queue TEXT NOT NULL DEFAULT 'default',
          job_class TEXT NOT NULL,
          payload TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          available_at INTEGER NOT NULL,
          reserved_at INTEGER,
          created_at INTEGER NOT NULL
        )
      `);
      await this.connection.run(`CREATE INDEX IF NOT EXISTS ${t}_queue_available ON ${t} (queue, available_at, reserved_at)`);
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS ${f} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          queue TEXT NOT NULL,
          job_class TEXT NOT NULL,
          payload TEXT NOT NULL,
          exception TEXT NOT NULL,
          failed_at INTEGER NOT NULL
        )
      `);
    } else if (driver === "mysql") {
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS \`${t}\` (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          queue VARCHAR(255) NOT NULL DEFAULT 'default',
          job_class VARCHAR(512) NOT NULL,
          payload LONGTEXT NOT NULL,
          attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
          max_attempts TINYINT UNSIGNED NOT NULL DEFAULT 3,
          available_at INT UNSIGNED NOT NULL,
          reserved_at INT UNSIGNED,
          created_at INT UNSIGNED NOT NULL,
          INDEX ${t}_queue_available (queue, available_at, reserved_at)
        )
      `);
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS \`${f}\` (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          queue VARCHAR(255) NOT NULL,
          job_class VARCHAR(512) NOT NULL,
          payload LONGTEXT NOT NULL,
          exception LONGTEXT NOT NULL,
          failed_at INT UNSIGNED NOT NULL
        )
      `);
    } else {
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS ${t} (
          id BIGSERIAL PRIMARY KEY,
          queue VARCHAR(255) NOT NULL DEFAULT 'default',
          job_class VARCHAR(512) NOT NULL,
          payload TEXT NOT NULL,
          attempts SMALLINT NOT NULL DEFAULT 0,
          max_attempts SMALLINT NOT NULL DEFAULT 3,
          available_at INTEGER NOT NULL,
          reserved_at INTEGER,
          created_at INTEGER NOT NULL
        )
      `);
      await this.connection.run(`CREATE INDEX IF NOT EXISTS ${t}_queue_available ON ${t} (queue, available_at, reserved_at)`);
      await this.connection.run(`
        CREATE TABLE IF NOT EXISTS ${f} (
          id BIGSERIAL PRIMARY KEY,
          queue VARCHAR(255) NOT NULL,
          job_class VARCHAR(512) NOT NULL,
          payload TEXT NOT NULL,
          exception TEXT NOT NULL,
          failed_at INTEGER NOT NULL
        )
      `);
    }
  }

  private placeholders(count: number): string {
    if (this.connection.getDriverName() === "postgres") {
      return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(", ");
    }
    return Array.from({ length: count }, () => "?").join(", ");
  }

  async dispatch(queue: string, jobClass: string, payload: string, delaySeconds: number, maxAttempts: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const availableAt = now + delaySeconds;
    const t = this.table;
    const driver = this.connection.getDriverName();

    if (driver === "mysql") {
      await this.connection.run(
        `INSERT INTO \`${t}\` (queue, job_class, payload, attempts, max_attempts, available_at, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
        [queue, jobClass, payload, maxAttempts, availableAt, now],
      );
    } else if (driver === "postgres") {
      await this.connection.run(
        `INSERT INTO ${t} (queue, job_class, payload, attempts, max_attempts, available_at, created_at) VALUES ($1, $2, $3, 0, $4, $5, $6)`,
        [queue, jobClass, payload, maxAttempts, availableAt, now],
      );
    } else {
      await this.connection.run(
        `INSERT INTO ${t} (queue, job_class, payload, attempts, max_attempts, available_at, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)`,
        [queue, jobClass, payload, maxAttempts, availableAt, now],
      );
    }
  }

  async reserve(queue: string, retryAfterSeconds: number): Promise<JobRecord | null> {
    const now = Math.floor(Date.now() / 1000);
    const expiredCutoff = now - retryAfterSeconds;
    const driver = this.connection.getDriverName();
    const t = this.table;

    if (driver === "sqlite") {
      return this.withSqliteMutex(async () => this.connection.transaction(async (conn) => {
        const rows = (await conn.query(
          `SELECT * FROM ${t}
           WHERE queue = ? AND (reserved_at IS NULL OR reserved_at <= ?) AND available_at <= ?
           ORDER BY id ASC LIMIT 1`,
          [queue, expiredCutoff, now],
        )) as RawJobRow[];
        const row = rows[0];
        if (!row) return null;
        await conn.run(
          `UPDATE ${t} SET reserved_at = ?, attempts = attempts + 1 WHERE id = ?`,
          [now, row.id],
        );
        return toJobRecord({ ...row, reserved_at: now, attempts: row.attempts + 1 });
      }));
    }

    if (driver === "postgres") {
      return this.connection.transaction(async (conn) => {
        const rows = (await conn.query(
          `SELECT * FROM ${t}
           WHERE queue = $1 AND (reserved_at IS NULL OR reserved_at <= $2) AND available_at <= $3
           ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [queue, expiredCutoff, now],
        )) as RawJobRow[];
        const row = rows[0];
        if (!row) return null;
        await conn.run(
          `UPDATE ${t} SET reserved_at = $1, attempts = attempts + 1 WHERE id = $2`,
          [now, row.id],
        );
        return toJobRecord({ ...row, reserved_at: now, attempts: row.attempts + 1 });
      });
    }

    const skipLocked = "FOR UPDATE SKIP LOCKED";
    const tq = `\`${t}\``;

    return this.connection.transaction(async (conn) => {
      const rows = (await conn.query(
        `SELECT * FROM ${tq}
         WHERE queue = ? AND (reserved_at IS NULL OR reserved_at <= ?) AND available_at <= ?
         ORDER BY id ASC LIMIT 1 ${skipLocked}`,
        [queue, expiredCutoff, now],
      )) as RawJobRow[];
      const row = rows[0];
      if (!row) return null;
      await conn.run(
        `UPDATE ${tq} SET reserved_at = ?, attempts = attempts + 1 WHERE id = ?`,
        [now, row.id],
      );
      return toJobRecord({ ...row, reserved_at: now, attempts: row.attempts + 1 });
    });
  }

  async complete(id: number): Promise<void> {
    const driver = this.connection.getDriverName();
    const t = driver === "mysql" ? `\`${this.table}\`` : this.table;
    if (driver === "postgres") {
      await this.connection.run(`DELETE FROM ${t} WHERE id = $1`, [id]);
    } else {
      await this.connection.run(`DELETE FROM ${t} WHERE id = ?`, [id]);
    }
  }

  async fail(id: number, exception: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const driver = this.connection.getDriverName();
    const t = driver === "mysql" ? `\`${this.table}\`` : this.table;
    const f = driver === "mysql" ? `\`${this.failedTable}\`` : this.failedTable;

    const failWork = async () => this.connection.transaction(async (conn) => {
      const rows = (await conn.query(`SELECT * FROM ${t} WHERE id = ${driver === "postgres" ? "$1" : "?"}`, [id])) as RawJobRow[];
      const row = rows[0];
      if (!row) return;
      if (driver === "postgres") {
        await conn.run(
          `INSERT INTO ${f} (queue, job_class, payload, exception, failed_at) VALUES ($1, $2, $3, $4, $5)`,
          [row.queue, row.job_class, row.payload, exception, now],
        );
        await conn.run(`DELETE FROM ${t} WHERE id = $1`, [id]);
      } else {
        await conn.run(
          `INSERT INTO ${f} (queue, job_class, payload, exception, failed_at) VALUES (?, ?, ?, ?, ?)`,
          [row.queue, row.job_class, row.payload, exception, now],
        );
        await conn.run(`DELETE FROM ${t} WHERE id = ?`, [id]);
      }
    });
    if (driver === "sqlite") {
      await this.withSqliteMutex(failWork);
      return;
    }
    await failWork();
  }

  async release(id: number, delaySeconds: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const availableAt = now + delaySeconds;
    const driver = this.connection.getDriverName();
    const t = driver === "mysql" ? `\`${this.table}\`` : this.table;
    if (driver === "postgres") {
      await this.connection.run(
        `UPDATE ${t} SET reserved_at = NULL, available_at = $1 WHERE id = $2`,
        [availableAt, id],
      );
    } else {
      await this.connection.run(
        `UPDATE ${t} SET reserved_at = NULL, available_at = ? WHERE id = ?`,
        [availableAt, id],
      );
    }
  }

  async size(queue?: string): Promise<number> {
    const driver = this.connection.getDriverName();
    const t = driver === "mysql" ? `\`${this.table}\`` : this.table;
    const rows = (queue
      ? driver === "postgres"
        ? await this.connection.query(`SELECT COUNT(*) as cnt FROM ${t} WHERE queue = $1`, [queue])
        : await this.connection.query(`SELECT COUNT(*) as cnt FROM ${t} WHERE queue = ?`, [queue])
      : await this.connection.query(`SELECT COUNT(*) as cnt FROM ${t}`)) as { cnt: number }[];
    return Number(rows[0]?.cnt ?? 0);
  }
}
