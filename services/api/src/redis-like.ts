// The narrow Redis surface the api uses. Both ioredis Redis and ioredis Cluster
// satisfy this; so does the FakeRedis used in unit tests. Keeping it small
// avoids coupling the api to ioredis-specific behaviour.

export interface RedisLike {
  call(command: string, ...args: unknown[]): Promise<unknown>;
  dbsize(): Promise<number>;
  info(...args: unknown[]): Promise<string>;
  scan(cursor: string | number, ...args: unknown[]): Promise<[string, string[]]>;
}
