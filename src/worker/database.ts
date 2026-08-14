import type { RelayDatabase, SqlBatchStatement } from '../server/database.js';

export class DurableRelayDatabase implements RelayDatabase {
  constructor(private readonly storage: DurableObjectStorage) {}

  close(): void {}
  async exec(sql: string): Promise<void> { this.storage.sql.exec(sql).toArray(); }
  async all(sql: string, params: unknown[] = []) {
    return this.storage.sql.exec(sql, ...params).toArray() as Record<string, unknown>[];
  }
  async get(sql: string, params: unknown[] = []) {
    return this.storage.sql.exec(sql, ...params).toArray()[0] as Record<string, unknown> | undefined;
  }
  async run(sql: string, params: unknown[] = []) {
    return { changes: this.storage.sql.exec(sql, ...params).rowsWritten };
  }
  async batch(statements: SqlBatchStatement[]): Promise<void> {
    this.storage.transactionSync(() => {
      for (const statement of statements) this.storage.sql.exec(statement.sql, ...(statement.params ?? []));
    });
  }
}
