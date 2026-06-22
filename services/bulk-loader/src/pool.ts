// Wave 7.0.1.A — bulk-loader connection pool (skeleton).
//
// Opens N parallel non-cluster ioredis connections to the Redis Enterprise
// proxy endpoint. OSS Cluster API is NOT enabled on the test or davpin DBs,
// so we connect each client standalone — parallelism comes from the pool
// size, and proxy_policy=all-master-shards spreads connections across master
// nodes inside the cluster. No client-side slot routing happens here; the
// write path (Wave 7.0.1.B) will round-robin ULID-keyed HSETs across these
// workers and let the proxy place each one.
//
// Workers expose state + last_heartbeat for /load/status. Heartbeat is a
// pure log line until the write path lands; once writes start it will also
// stamp last_flush_at. Reconnect is handled by ioredis defaults (we listen
// to "ready"/"end"/"close"/"reconnecting" but do not call client.connect()
// or disable retries).

export type WorkerState = "connecting" | "connected" | "disconnected";

// Narrow surface a pool client must expose. ioredis Redis satisfies this
// without modification (it extends EventEmitter and ships `status` +
// `disconnect`); tests inject EventEmitter-backed fakes that match the
// same shape. Kept structural (not `extends EventEmitter`) so the cast
// from `Redis | Cluster` in src/index.ts doesn't drag in the full
// EventEmitter type hierarchy.
export interface PoolClient {
  status?: string;
  disconnect(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface Worker {
  id: number;
  state: WorkerState;
  lastHeartbeat: number | null;
  lastFlushAt: number | null;
  client: PoolClient;
}

export interface PoolStatus {
  poolSize: number;
  connected: number;
  workers: Array<{
    id: number;
    state: WorkerState;
    last_heartbeat: number | null;
    last_flush_at: number | null;
  }>;
}

export interface PoolOptions {
  size: number;
  redisFactory: (workerId: number) => PoolClient;
  heartbeatMs?: number;
  logger?: { info: (obj: object, msg: string) => void };
  // healthyFraction defaults to 0.75 per task brief.
  healthyFraction?: number;
  now?: () => number;
}

export interface WorkerPool {
  workers: Worker[];
  status(): PoolStatus;
  isHealthy(): boolean;
  stop(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_HEALTHY_FRACTION = 0.75;

export function createWorkerPool(opts: PoolOptions): WorkerPool {
  if (!Number.isInteger(opts.size) || opts.size < 1) {
    throw new Error(`createWorkerPool: size must be a positive integer (got ${String(opts.size)})`);
  }
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const healthyFraction = opts.healthyFraction ?? DEFAULT_HEALTHY_FRACTION;
  const now = opts.now ?? Date.now;
  const log = opts.logger ?? {
    info: (obj, msg) => console.log(JSON.stringify({ service: "bulk-loader", msg, ...obj })),
  };

  const workers: Worker[] = [];
  for (let i = 0; i < opts.size; i++) {
    const client = opts.redisFactory(i);
    // Wave 7.0.1.A — seed state from ioredis.status when present. A client
    // built with lazyConnect:false starts in "connecting"; once ioredis fires
    // "ready" the state advances. Tests injecting EventEmitter fakes leave
    // status undefined and emit events explicitly.
    const initial: WorkerState = client.status === "ready" ? "connected" : "connecting";
    const worker: Worker = {
      id: i,
      state: initial,
      lastHeartbeat: null,
      lastFlushAt: null,
      client,
    };
    client.on("ready", () => {
      worker.state = "connected";
      log.info({ worker_id: i }, "worker connected");
    });
    client.on("end", () => {
      worker.state = "disconnected";
      log.info({ worker_id: i }, "worker disconnected");
    });
    client.on("close", () => {
      // Wave 7.0.1.A — ioredis emits "close" before "reconnecting" on a
      // dropped socket; map both to disconnected so /load/status reflects
      // the gap. "ready" on the new socket flips it back.
      worker.state = "disconnected";
    });
    client.on("reconnecting", () => {
      worker.state = "connecting";
    });
    client.on("error", (err: unknown) => {
      log.info({ worker_id: i, err: String(err) }, "worker error");
    });
    workers.push(worker);
  }

  const timer: NodeJS.Timeout = setInterval(() => {
    const ts = now();
    for (const w of workers) {
      w.lastHeartbeat = ts;
      log.info(
        { worker_id: w.id, state: w.state, last_flush_at: w.lastFlushAt },
        "worker heartbeat",
      );
    }
  }, heartbeatMs);
  if (typeof timer.unref === "function") timer.unref();

  function status(): PoolStatus {
    const connected = workers.filter((w) => w.state === "connected").length;
    return {
      poolSize: workers.length,
      connected,
      workers: workers.map((w) => ({
        id: w.id,
        state: w.state,
        last_heartbeat: w.lastHeartbeat,
        last_flush_at: w.lastFlushAt,
      })),
    };
  }

  function isHealthy(): boolean {
    const s = status();
    return s.connected >= Math.ceil(s.poolSize * healthyFraction);
  }

  async function stop(): Promise<void> {
    clearInterval(timer);
    for (const w of workers) {
      try { w.client.disconnect(); } catch { /* ignore */ }
    }
  }

  return { workers, status, isHealthy, stop };
}
