// Active-target watcher (Wave 5.16v) — mirror of source's 5.16u watcher.
//
// Polls the api's /internal/redis/active-target/full endpoint every 5s and
// tracks the api's current Redis target by `version`. loadgen does not
// instantiate ioredis (it drives the api over HTTP), so this watcher carries
// no Redis client — its only side-effect is an integration log line on each
// version bump. 5.16w's in-flight registry rejects target switches while a
// loadgen run is active, so the `running` flag we log alongside the swap is
// expected to be `false` in normal operation; if it ever reads `true`, the
// lockout has failed. NEVER log the bearer token or the password.

export interface ActiveTargetFull {
  host: string;
  port: number;
  tls: boolean;
  db: number;
  password?: string;
  label: string;
  version: number;
}

export interface WatcherLogger {
  info(msg: string): void;
  warn(msg: string, err?: unknown): void;
}

export interface WatcherOpts {
  apiBase: string;
  token: string;
  pollMs?: number;
  initialTimeoutMs?: number;
  initialRetryMs?: number;
  fetchImpl?: typeof fetch;
  logger?: WatcherLogger;
  // Optional probe so the swap log records whether a run was in progress.
  // The 5.16w lockout means this should always read false in practice;
  // logging it makes lockout regressions obvious in the integration logs.
  isRunning?: () => boolean;
}

export interface ActiveTargetWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  pollOnce(): Promise<void>;
  getCurrent(): ActiveTargetFull;
}

const defaultLogger: WatcherLogger = {
  info: (msg) => console.log(JSON.stringify({ service: "loadgen", msg })),
  warn: (msg, err) =>
    console.warn(JSON.stringify({ service: "loadgen", level: "warn", msg, err: err ? String(err) : undefined })),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Strip the password before any log/return to callers — defence-in-depth
// against accidental serialisation.
function redact(t: ActiveTargetFull): Omit<ActiveTargetFull, "password"> {
  const { password: _pw, ...rest } = t;
  void _pw;
  return rest;
}

export function createActiveTargetWatcher(opts: WatcherOpts): ActiveTargetWatcher {
  const pollMs = opts.pollMs ?? 5000;
  const initialTimeoutMs = opts.initialTimeoutMs ?? 30_000;
  const initialRetryMs = opts.initialRetryMs ?? 1_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const logger = opts.logger ?? defaultLogger;
  const isRunning = opts.isRunning ?? (() => false);

  let current: ActiveTargetFull | null = null;
  let currentVersion: number | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  async function fetchTarget(): Promise<ActiveTargetFull> {
    const url = `${opts.apiBase}/internal/redis/active-target/full`;
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${opts.token}` } });
    if (!r.ok) throw new Error(`api ${r.status}`);
    return (await r.json()) as ActiveTargetFull;
  }

  function swapTo(t: ActiveTargetFull): void {
    if (t.version === currentVersion) return;
    const wasRunning = isRunning();
    current = t;
    currentVersion = t.version;
    // Integration log: every watcher-driven swap. `running` should be false
    // under the 5.16w lockout — true means lockout regression.
    logger.info(`active target: ${t.label} (version=${t.version}, running=${wasRunning})`);
  }

  async function pollOnce(): Promise<void> {
    try {
      const t = await fetchTarget();
      swapTo(t);
    } catch (err) {
      logger.warn("active-target poll failed; keeping current target", err);
    }
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => { void pollOnce(); }, pollMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
  }

  async function start(): Promise<void> {
    const deadline = Date.now() + initialTimeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const t = await fetchTarget();
        swapTo(t);
        startPolling();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(initialRetryMs);
      }
    }
    // loadgen does not need a Redis client to function — if the api is
    // unreachable on boot we keep polling in the background rather than
    // crash; /loadgen/start still works against API_URL.
    logger.warn("active-target watcher: api unreachable on startup; will keep polling", lastErr);
    startPolling();
  }

  async function stop(): Promise<void> {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    current = null;
    currentVersion = null;
  }

  function getCurrent(): ActiveTargetFull {
    if (!current) throw new Error("active-target watcher: getCurrent() called before a successful poll");
    return redact(current) as ActiveTargetFull;
  }

  return { start, stop, pollOnce, getCurrent };
}
