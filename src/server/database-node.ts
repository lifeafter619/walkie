import Database from 'better-sqlite3';
import type { RelayDatabase, SqlBatchStatement } from './database.js';
import { RelayRepository } from './database.js';

class NodeRelayDatabase implements RelayDatabase {
  constructor(private readonly db: Database.Database) {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  close(): void { this.db.close(); }
  async exec(sql: string): Promise<void> { this.db.exec(sql); }
  async all(sql: string, params: unknown[] = []) { return this.db.prepare(sql).all(...params) as Record<string, unknown>[]; }
  async get(sql: string, params: unknown[] = []) { return this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined; }
  async run(sql: string, params: unknown[] = []) { return { changes: this.db.prepare(sql).run(...params).changes }; }
  async batch(statements: SqlBatchStatement[]): Promise<void> {
    this.db.transaction(() => {
      for (const statement of statements) this.db.prepare(statement.sql).run(...(statement.params ?? []));
    })();
  }
}

export async function createNodeRepository(databasePath: string, masterKey: Buffer): Promise<RelayRepository> {
  const repository = new RelayRepository(new NodeRelayDatabase(new Database(databasePath)), masterKey);
  await repository.init();
  return repository;
}
