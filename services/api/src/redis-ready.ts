// FRTB SBM PoV — bounded Redis-ready gate for api startup.
//
// Wave 5.8.1: ioredis Cluster auto-connects on construction, so calling
// .connect() on a Cluster throws "Redis is already connecting/connected"
// and trips the existing graceful-degrade branch — which then silently skips
// bootstrap (idx:sens + frtb FUNCTION LOAD). Fix the gate without changing
// failure semantics:
//   - Cluster path (REDIS_URL set): wait for the 'ready' event with a
//     bounded timeout instead of calling .connect().
//   - Standalone path (no REDIS_URL): still call .connect(), but tolerate
//     the "already connecting/connected" auto-connect error as a no-op.
// Either path reports redisConnected so the bootstrap gate in index.ts is
// structurally unchanged.

import type { Cluster, Redis } from "ioredis";

export type RedisConnectionMode = "cluster" | "standalone";

export interface RedisReadiness {
  connected: boolean;
  mode: RedisConnectionMode;
  err?: unknown;
}

export interface EnsureRedisReadyOptions {
  // cluster=true → ioredis Cluster (auto-connects on construction); wait for
  // the 'ready' event. cluster=false → standalone Redis with lazyConnect:true;
  // call .connect(). Wave 5.15r: dispatch must key off the cluster flag (not
  // URL presence) — a standalone client can perfectly well have a REDIS_URL.
  cluster: boolean;
  // Bound the wait so /healthz still comes up even if Redis never becomes
  // ready. Defaults to 5 000 ms.
  timeoutMs?: number;
}

interface ReadyEmitter {
  status?: string;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

function isAlreadyConnectingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already connect(ing|ed)/i.test(msg);
}

export async function ensureRedisReady(
  redis: Redis | Cluster,
  opts: EnsureRedisReadyOptions
): Promise<RedisReadiness> {
  const mode: RedisConnectionMode = opts.cluster ? "cluster" : "standalone";
  const envTimeout = Number(process.env.REDIS_READY_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5_000);

  if (mode === "cluster") {
    const emitter = redis as unknown as ReadyEmitter;
    if (emitter.status === "ready") return { connected: true, mode };

    return await new Promise<RedisReadiness>((resolve) => {
      let settled = false;
      const finish = (r: RedisReadiness): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const remove = emitter.off ?? emitter.removeListener;
        remove?.call(emitter, "ready", onReady);
        remove?.call(emitter, "error", onError);
        resolve(r);
      };
      const onReady = (): void => finish({ connected: true, mode });
      const onError = (err: unknown): void => finish({ connected: false, mode, err });
      const timer = setTimeout(
        () => finish({ connected: false, mode, err: new Error(`redis-ready timeout after ${timeoutMs}ms`) }),
        timeoutMs
      );
      emitter.once("ready", onReady);
      emitter.once("error", onError);
    });
  }

  // Standalone path — keep the explicit .connect() flow, but tolerate the
  // auto-connect error in case the client started connecting on its own.
  try {
    await (redis as Redis).connect();
    return { connected: true, mode };
  } catch (err) {
    if (isAlreadyConnectingError(err)) return { connected: true, mode };
    return { connected: false, mode, err };
  }
}
