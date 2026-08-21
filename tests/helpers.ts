import type { AppConfig } from '../src/server/config.js';

/**
 * 测试共用类型工具。
 *
 * `vi.fn(...) as unknown as typeof fetch` 会把 mock 属性一起丢掉，测试却既要把它传给
 * dispatcher（需要 `typeof fetch`），又要读调用记录（需要 `.mock`）。这里把两者并起来，
 * 免得每个断言都退化成 any。
 */
export type MockFetch = typeof fetch & {
  mock: { calls: Array<[RequestInfo | URL, RequestInit | undefined]> };
};

/** createApp 只用到 AppConfig 的一部分；测试里补全默认值，避免每处都写 `as never` */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 4310,
    host: '127.0.0.1',
    dataDir: '.',
    databasePath: ':memory:',
    masterKey: Buffer.alloc(32),
    allowPrivateWebhooks: false,
    allowInsecureHttp: false,
    deliveryWorkers: 1,
    maxSendsPerMin: 0,
    maxDeliveryAttempts: 1,
    retryBaseMs: 1,
    isProduction: false,
    platform: 'node',
    ...overrides
  };
}
