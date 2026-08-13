import { createClient, type Client } from '@libsql/client';
import type { RelayDatabase, SqlBatchStatement } from './database.js';
import { RelayRepository } from './database.js';

class LibsqlRelayDatabase implements RelayDatabase {
  constructor(private readonly client: Client) {}

  close(): void { this.client.close(); }
  async exec(sql: string): Promise<void> { await this.client.executeMultiple(sql); }
  async all(sql: string, params: unknown[] = []) {
    const result = await this.client.execute({ sql, args: params as never[] });
    return result.rows.map((row) => ({ ...row })) as Record<string, unknown>[];
  }
  async get(sql: string, params: unknown[] = []) {
    return (await this.all(sql, params))[0];
  }
  async run(sql: string, params: unknown[] = []) {
    const result = await this.client.execute({ sql, args: params as never[] });
    return { changes: result.rowsAffected };
  }
  async batch(statements: SqlBatchStatement[]): Promise<void> {
    await this.client.batch(statements.map((s) => ({ sql: s.sql, args: (s.params ?? []) as never[] })), 'write');
  }
}

/** Turso/libSQL 远程库（Vercel 等无持久盘环境），或 file: URL 本地库 */
export async function createLibsqlRepository(url: string, authToken: string | undefined, masterKey: Buffer): Promise<RelayRepository> {
  const repository = new RelayRepository(new LibsqlRelayDatabase(createClient({ url, authToken })), masterKey);
  await repository.init();
  return repository;
}
