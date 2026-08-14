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

/**
 * @param databasePath SQLite 路径或 ':memory:'
 * @param masterKey KEK（env MASTER_KEY）；DEK 由 init() 内部自举
 * @param existing 可选的已预置 schema/数据的 better-sqlite3 实例（用于测试迁移）；
 *   传入时跳过 new Database(path)，但 repository 仍会调用 init() 建表/迁移。
 */
export async function createNodeRepository(databasePath: string, masterKey: Buffer, existing?: Database.Database): Promise<RelayRepository> {
  const db = existing ?? new Database(databasePath);
  const repository = new RelayRepository(new NodeRelayDatabase(db), masterKey);
  await repository.init();
  return repository;
}
