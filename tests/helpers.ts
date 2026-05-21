import { Connection, Model, Schema } from "../src/index.js";
import { rm } from "fs/promises";

export function setupTestDb() {
  const connection = new Connection({ url: "sqlite://:memory:" });
  Model.setConnection(connection);
  Schema.setConnection(connection);
  return connection;
}

export async function teardownTestDb(connection: Connection) {
  await connection.driver.close();
}

export async function cleanupSqliteFile(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}-wal`, { force: true });
  await rm(`${path}-shm`, { force: true });
}
