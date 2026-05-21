import { SQL, FileSink } from "bun";
import type { ConnectionConfig } from "../types/index.js";
import { Grammar } from "../query/grammars/Grammar.js";
import { SQLiteGrammar } from "../query/grammars/SQLiteGrammar.js";
import { MySqlGrammar } from "../query/grammars/MySqlGrammar.js";
import { PostgresGrammar } from "../query/grammars/PostgresGrammar.js";

export class Connection {
  readonly driver: SQL;
  private driverName: "sqlite" | "mysql" | "postgres";
  private grammar: Grammar;
  private config: ConnectionConfig;
  private schema?: string;
  private ownsDriver: boolean;
  private transactionDepth = 0;
  private transactionActive = false;
  private transactionRoot = false;
  private savepointId = 0;
  private dedicated = false;
  private reservedDriver?: SQL & { release?: () => void };
  private abandonedTimer?: ReturnType<typeof setTimeout>;
  private sqliteDefaultsApplied = false;
  private sqliteDefaultsPromise?: Promise<void>;
  /** When set (ms), a manual beginTransaction() with no commit/rollback within this window is auto-rolled-back and its pooled connection released. Opt-in. */
  static abandonedTransactionTimeoutMs?: number;
  static logQueries = false;
  static queryLogFile?: string;
  static logToConsole: boolean = true;
  private static _logWriter?: FileSink;
  private static _logWriterDate?: string;
  static defaultPostgresPoolMax = 10;
  logQueries?: boolean;

  constructor(config: ConnectionConfig, options: { driver?: SQL; schema?: string; ownsDriver?: boolean; sqliteDefaultsApplied?: boolean } = {}) {
    this.config = config;
    this.schema = options.schema || ("schema" in config ? config.schema : undefined);
    this.ownsDriver = options.ownsDriver ?? !options.driver;
    let url: string;
    if ("url" in config && config.url) {
      url = config.url;
    } else if ("driver" in config) {
      const c = config as any;
      if (c.driver === "sqlite") {
        url = `sqlite://${c.filename || c.database || ":memory:"}`;
      } else {
        const protocol = c.driver === "mysql" ? "mysql" : "postgres";
        url = `${protocol}://${c.username || ""}:${c.password || ""}@${c.host || "localhost"}:${c.port || (c.driver === "mysql" ? 3306 : 5432)}/${c.database || ""}`;
      }
    } else {
      throw new Error("Invalid connection configuration. Provide a url or driver config.");
    }

    this.driverName = url.startsWith("sqlite")
      ? "sqlite"
      : url.startsWith("mysql")
      ? "mysql"
      : "postgres";
    this.driver = options.driver || (() => {
      if (this.driverName === "sqlite") {
        return new SQL(url);
      }

      const prepare = config.prepare ?? (this.driverName === "postgres" ? false : undefined);
      const max = config.max ?? (this.driverName === "postgres" ? Connection.defaultPostgresPoolMax : undefined);
      return new SQL({
        url,
        ...(max !== undefined ? { max } : {}),
        ...(prepare !== undefined ? { prepare } : {}),
      });
    })();

    switch (this.driverName) {
      case "sqlite":
        this.grammar = new SQLiteGrammar();
        break;
      case "mysql":
        this.grammar = new MySqlGrammar();
        break;
      case "postgres":
        this.grammar = new PostgresGrammar();
        break;
    }
    this.sqliteDefaultsApplied =
      this.driverName !== "sqlite" ||
      options.sqliteDefaultsApplied === true;
  }

  getDriverName(): "sqlite" | "mysql" | "postgres" {
    return this.driverName;
  }

  getGrammar(): Grammar {
    return this.grammar;
  }

  getSchema(): string | undefined {
    return this.schema;
  }

  getConfig(): ConnectionConfig {
    return this.config;
  }

  static isSafeIdentifier(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  }

  static assertSafeIdentifier(value: string, label: string = "identifier"): void {
    if (!this.isSafeIdentifier(value)) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
  }

  static assertSafeQualifiedIdentifier(value: string, label: string = "identifier"): void {
    const parts = value.split(".");
    if (parts.length === 0 || parts.some((part) => !this.isSafeIdentifier(part))) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
  }

  withSchema(schema: string): Connection {
    Connection.assertSafeIdentifier(schema, "schema name");
    if (this.schema === schema) return this;
    const conn = new Connection(this.config, { driver: this.driver, schema, ownsDriver: false, sqliteDefaultsApplied: this.sqliteDefaultsApplied });
    conn.logQueries = this.logQueries;
    return conn;
  }

  withoutSchema(): Connection {
    if (!this.schema) return this;
    const conn = new Connection(this.config, { driver: this.driver, ownsDriver: false, sqliteDefaultsApplied: this.sqliteDefaultsApplied });
    conn.logQueries = this.logQueries;
    return conn;
  }

  qualifyTable(table: string): string {
    if (table.includes(".")) {
      Connection.assertSafeQualifiedIdentifier(table, "qualified table name");
      return table;
    }
    Connection.assertSafeIdentifier(table, "table name");
    if (!this.schema || this.driverName === "sqlite") return table;
    return `${this.schema}.${table}`;
  }

  quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  private getDriver(): SQL {
    return this.reservedDriver || this.driver;
  }

  private log(sqlString: string, bindings?: any[]): void {
    if (!(this.logQueries ?? Connection.logQueries)) return;
    if (Connection.queryLogFile) {
      const date = new Date().toISOString().slice(0, 10);
      if (Connection._logWriterDate !== date) {
        Connection._logWriter?.flush();
        Connection._logWriter?.end();
        const path = `${Connection.queryLogFile}/query-${date}.log`;
        Connection._logWriter = Bun.file(path).writer();
        Connection._logWriterDate = date;
      }
      const line = `[QUERY] ${sqlString}${bindings?.length ? " " + JSON.stringify(bindings) : ""}\n`;
      Connection._logWriter!.write(line);
      Connection._logWriter!.flush();
    }
    if (Connection.logToConsole) {
      console.log("[QUERY]", sqlString, bindings?.length ? bindings : "");
    }
  }

  private normalizeBinding(value: any): any {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => this.normalizeBinding(item));
    return value;
  }

  private normalizeBindings(bindings?: any[]): any[] | undefined {
    return bindings?.map((binding) => this.normalizeBinding(binding));
  }

  async query(sqlString: string, bindings?: any[]): Promise<any[]> {
    await this.ensureSqliteDefaults();
    const normalizedBindings = this.normalizeBindings(bindings);
    this.log(sqlString, normalizedBindings);
    return (await this.getDriver().unsafe(sqlString, normalizedBindings)) as any[];
  }

  async run(sqlString: string, bindings?: any[]): Promise<any> {
    await this.ensureSqliteDefaults();
    const normalizedBindings = this.normalizeBindings(bindings);
    this.log(sqlString, normalizedBindings);
    return await this.getDriver().unsafe(sqlString, normalizedBindings);
  }

  private async ensureSqliteDefaults(): Promise<void> {
    if (this.sqliteDefaultsApplied || this.driverName !== "sqlite") return;
    if (!this.sqliteDefaultsPromise) {
      this.sqliteDefaultsPromise = this.applySqliteDefaults();
    }
    await this.sqliteDefaultsPromise;
  }

  private async applySqliteDefaults(): Promise<void> {
    const pragmas = this.config.sqlitePragmas;
    if (pragmas === false) {
      this.sqliteDefaultsApplied = true;
      return;
    }

    const journalMode = pragmas?.journalMode ?? "WAL";
    const synchronous = pragmas?.synchronous ?? "NORMAL";

    if (journalMode !== false) {
      const sql = `PRAGMA journal_mode=${this.sanitizeSqlitePragmaValue(journalMode, "journal_mode")}`;
      this.log(sql);
      await this.getDriver().unsafe(sql);
    }

    if (synchronous !== false) {
      const sql = `PRAGMA synchronous=${this.sanitizeSqlitePragmaValue(synchronous, "synchronous")}`;
      this.log(sql);
      await this.getDriver().unsafe(sql);
    }

    this.sqliteDefaultsApplied = true;
  }

  private sanitizeSqlitePragmaValue(value: string, pragma: string): string {
    if (!/^[A-Za-z0-9_]+$/.test(value)) {
      throw new Error(`Invalid SQLite ${pragma} value: ${value}`);
    }
    return value;
  }

  async beginTransaction(): Promise<void> {
    await this.ensureSqliteDefaults();
    if (this.transactionDepth === 0 && !this.transactionActive) {
      if (this.driverName === "postgres" && !this.dedicated) {
        this.reservedDriver = await (this.driver as any).reserve();
      }
      try {
        await this.getDriver().unsafe("BEGIN");
      } catch (error) {
        this.releaseReservedDriver();
        throw error;
      }
      this.transactionActive = true;
      this.transactionRoot = true;
      this.transactionDepth = 1;
      this.armAbandonedTimer();
      return;
    }

    await this.getDriver().unsafe(`SAVEPOINT bunny_trans_${++this.savepointId}`);
    this.transactionDepth++;
  }

  private releaseReservedDriver(): void {
    this.clearAbandonedTimer();
    this.reservedDriver?.release?.();
    this.reservedDriver = undefined;
  }

  private armAbandonedTimer(): void {
    const ms = Connection.abandonedTransactionTimeoutMs;
    if (!ms || !this.reservedDriver) return;
    const timer = setTimeout(() => {
      // Still in the same root transaction with a reserved driver: caller
      // never committed or rolled back. Force-rollback and release the slot.
      if (!this.transactionActive || !this.reservedDriver) return;
      void Promise.resolve()
        .then(() => this.getDriver().unsafe("ROLLBACK"))
        .catch(() => null)
        .finally(() => {
          this.transactionDepth = 0;
          this.transactionActive = false;
          this.transactionRoot = false;
          this.releaseReservedDriver();
        });
    }, ms);
    (timer as any).unref?.();
    this.abandonedTimer = timer;
  }

  private clearAbandonedTimer(): void {
    if (this.abandonedTimer) {
      clearTimeout(this.abandonedTimer);
      this.abandonedTimer = undefined;
    }
  }

  async commit(): Promise<void> {
    if (this.transactionDepth <= 0) return;
    if (this.transactionDepth === 1 && this.transactionRoot) {
      try {
        await this.getDriver().unsafe("COMMIT");
      } catch (error) {
        await this.getDriver().unsafe("ROLLBACK").catch(() => null);
        throw error;
      } finally {
        this.transactionDepth = 0;
        this.transactionActive = false;
        this.transactionRoot = false;
        this.releaseReservedDriver();
      }
    } else {
      await this.getDriver().unsafe(`RELEASE SAVEPOINT bunny_trans_${this.savepointId--}`);
      this.transactionDepth--;
    }
  }

  async rollback(): Promise<void> {
    if (this.transactionDepth <= 0) return;
    if (this.transactionDepth === 1 && this.transactionRoot) {
      try {
        await this.getDriver().unsafe("ROLLBACK");
      } finally {
        this.transactionDepth = 0;
        this.transactionActive = false;
        this.transactionRoot = false;
        this.releaseReservedDriver();
      }
    } else {
      await this.getDriver().unsafe(`ROLLBACK TO SAVEPOINT bunny_trans_${this.savepointId}`);
      await this.getDriver().unsafe(`RELEASE SAVEPOINT bunny_trans_${this.savepointId--}`);
      this.transactionDepth--;
    }
  }

  isInTransaction(): boolean {
    return this.transactionActive || this.transactionDepth > 0;
  }

  async transaction<T>(callback: (connection: Connection) => T | Promise<T>): Promise<T> {
    await this.ensureSqliteDefaults();
    if (!this.ownsDriver) {
      // A borrowed connection can be either transaction-rooted already or
      // still outside any transaction. Track that separately from nesting
      // depth so a root transaction starts with BEGIN and nested calls use
      // SAVEPOINTs.
      if (!this.transactionActive) {
        if (this.driverName === "postgres" && !this.dedicated) {
          this.reservedDriver = await (this.driver as any).reserve();
        }
        try {
          await this.getDriver().unsafe("BEGIN");
        } catch (error) {
          this.releaseReservedDriver();
          throw error;
        }
        this.transactionActive = true;
        this.transactionRoot = true;
        this.transactionDepth = 1;
        try {
          const result = await callback(this);
          await this.getDriver().unsafe("COMMIT");
          return result;
        } catch (error) {
          await this.getDriver().unsafe("ROLLBACK").catch(() => null);
          throw error;
        } finally {
          this.transactionDepth = 0;
          this.transactionActive = false;
          this.transactionRoot = false;
          this.releaseReservedDriver();
        }
      }
      const savepointName = `bunny_trans_${++this.savepointId}`;
      await this.getDriver().unsafe(`SAVEPOINT ${savepointName}`);
      this.transactionDepth++;
      try {
        const result = await callback(this);
        await this.getDriver().unsafe(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (error) {
        await this.getDriver().unsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`).catch(() => null);
        await this.getDriver().unsafe(`RELEASE SAVEPOINT ${savepointName}`).catch(() => null);
        this.savepointId--;
        throw error;
      } finally {
        this.transactionDepth--;
      }
    }
    return await this.driver.begin(async (sql) => {
      const connection = new Connection(this.config, {
        driver: sql as unknown as SQL,
        schema: this.schema,
        ownsDriver: false,
        sqliteDefaultsApplied: true,
      });
      connection.logQueries = this.logQueries;
      connection.transactionActive = true;
      connection.transactionRoot = false;
      try {
        return await callback(connection);
      } finally {
        connection.transactionActive = false;
      }
    });
  }

  async withTenant<T>(
    tenantId: string,
    callback: (connection: Connection) => T | Promise<T>,
    setting: string = "app.tenant_id",
    role?: string
  ): Promise<T> {
    if (this.driverName !== "postgres") {
      return await this.transaction(callback);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(setting)) {
      throw new Error(`Invalid PostgreSQL setting name: ${setting}`);
    }
    if (role) {
      Connection.assertSafeIdentifier(role, "role name");
    }
    return await this.transaction(async (connection) => {
      if (role) {
        await connection.run(`SET LOCAL ROLE ${connection.quoteIdentifier(role)}`);
      }
      await connection.run(`SELECT set_config(${connection.getGrammar().placeholder(1)}, ${connection.getGrammar().placeholder(2)}, true)`, [setting, tenantId]);
      return await callback(connection);
    });
  }

  async withSearchPath<T>(schema: string, callback: (connection: Connection) => T | Promise<T>): Promise<T> {
    if (this.driverName !== "postgres") {
      throw new Error("search_path schema switching is only supported for PostgreSQL connections.");
    }
    Connection.assertSafeIdentifier(schema, "schema name");
    // Reserve a dedicated connection (no surrounding transaction) and set the
    // search_path at session scope. Avoids pinning the request inside one long
    // transaction (lock hold / idle-in-transaction). The connection is still
    // dedicated for the callback's duration, then reset and released.
    const reserved = (await (this.driver as any).reserve()) as SQL & { release?: () => void };
    // Set the connection schema to the target so introspection
    // (information_schema / pg_catalog queries that filter by schema name)
    // resolves the tenant schema, not the base one. SET search_path below
    // remains as a fallback for any raw SQL the ORM does not qualify.
    const connection = new Connection(this.config, {
      driver: reserved as unknown as SQL,
      schema,
      ownsDriver: false,
    });
    connection.logQueries = this.logQueries;
    connection.dedicated = true;
    try {
      await connection.run(`SET search_path TO ${connection.quoteIdentifier(schema)}`);
      return await callback(connection);
    } finally {
      await connection.run("RESET search_path").catch(() => null);
      reserved.release?.();
    }
  }

  async close(): Promise<void> {
    this.releaseReservedDriver();
    if (this.ownsDriver) {
      await this.driver.close();
    }
  }
}
