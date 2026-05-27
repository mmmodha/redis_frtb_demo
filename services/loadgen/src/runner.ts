// Concurrent workforce simulator — N worker loops fire pivot+calc requests
// at the api per the configured mix, recording latency per endpoint. Snapshot
// is computed on demand from latency reservoirs (see ./metrics.ts).
//
// We don't use a streaming load generator (autocannon/k6) here — the demo
// needs cheap start/stop from an HTTP control surface, mid-run reconfig,
// and a snapshot endpoint, all of which a hand-rolled loop gives us without
// pinning a subprocess lifecycle. autocannon stays in package.json for the
// CI burst-test scenario where pure throughput is the only thing measured.

import { percentile } from "./metrics.ts";

export type RunnerStatus = "idle" | "running" | "stopped";
export type EndpointKey = "pivot" | "calc";

export interface RunnerMix { pivot: number; calc: number; }

export interface RunnerConfig {
  concurrency: number;
  duration_sec: number;
  api_base: string;
  mix: RunnerMix;
  fetch?: typeof fetch;
}

export interface EndpointSnapshot {
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface RunnerSnapshot {
  running: boolean;
  total_requests: number;
  errors: number;
  throughput_rps: number;
  latency: { p50: number; p95: number; p99: number };
  per_endpoint: Record<EndpointKey, EndpointSnapshot>;
  elapsed_sec: number;
  config?: RunnerConfig;
}

const DEFAULTS: RunnerConfig = {
  concurrency: 200,
  duration_sec: 300,
  api_base: "http://api:3001",
  mix: { pivot: 0.5, calc: 0.5 },
};

// Tiny request bodies for the calc loop. The api's /calc/sbm endpoint
// expects { risk_class, sensitivity_type }; pivot accepts a query string.
const CALC_PAYLOAD = JSON.stringify({ risk_class: "GIRR", sensitivity_type: "Delta" });
const PIVOT_QUERY = "?dim=bucket";

export class Runner {
  private cfg: RunnerConfig | null = null;
  private workers: Promise<void>[] = [];
  private _status: RunnerStatus = "idle";
  private startedAt = 0;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private latencies: Record<EndpointKey, number[]> = { pivot: [], calc: [] };
  private counts: Record<EndpointKey, number> = { pivot: 0, calc: 0 };
  private errs: Record<EndpointKey, number> = { pivot: 0, calc: 0 };
  private abortCtrl: AbortController | null = null;

  status(): RunnerStatus { return this._status; }

  start(partial: Partial<RunnerConfig>): void {
    if (this._status === "running") {
      this.abortCtrl?.abort();
      this.workers = [];
    }
    const mix = partial.mix ?? DEFAULTS.mix;
    const cfg: RunnerConfig = {
      concurrency: partial.concurrency ?? DEFAULTS.concurrency,
      duration_sec: partial.duration_sec ?? DEFAULTS.duration_sec,
      api_base: partial.api_base ?? DEFAULTS.api_base,
      mix: { pivot: mix.pivot, calc: mix.calc },
      fetch: partial.fetch ?? globalThis.fetch,
    };
    this.cfg = cfg;
    this.latencies = { pivot: [], calc: [] };
    this.counts = { pivot: 0, calc: 0 };
    this.errs = { pivot: 0, calc: 0 };
    this.startedAt = Date.now();
    this._status = "running";
    this.abortCtrl = new AbortController();
    const signal = this.abortCtrl.signal;
    for (let i = 0; i < cfg.concurrency; i++) {
      this.workers.push(this.workerLoop(cfg, signal));
    }
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = setTimeout(() => { void this.stop(); }, cfg.duration_sec * 1000);
  }

  async stop(): Promise<void> {
    if (this._status !== "running") {
      if (this._status === "idle") this._status = "stopped";
      return;
    }
    this._status = "stopped";
    this.abortCtrl?.abort();
    if (this.durationTimer) { clearTimeout(this.durationTimer); this.durationTimer = null; }
    const inflight = this.workers;
    this.workers = [];
    await Promise.allSettled(inflight);
  }

  private pickEndpoint(mix: RunnerMix): EndpointKey {
    const total = mix.pivot + mix.calc;
    if (total <= 0) return "pivot";
    return Math.random() * total < mix.pivot ? "pivot" : "calc";
  }

  private async workerLoop(cfg: RunnerConfig, signal: AbortSignal): Promise<void> {
    const f = cfg.fetch!;
    while (!signal.aborted && this._status === "running") {
      const ep = this.pickEndpoint(cfg.mix);
      const url = ep === "pivot" ? `${cfg.api_base}/pivot${PIVOT_QUERY}` : `${cfg.api_base}/calc/sbm`;
      const init: RequestInit = ep === "pivot"
        ? { method: "GET" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: CALC_PAYLOAD };
      const t0 = Date.now();
      try {
        const res = await f(url, init);
        const dt = Date.now() - t0;
        this.latencies[ep].push(dt);
        this.counts[ep] += 1;
        if (!res.ok) this.errs[ep] += 1;
        try { await res.text?.(); } catch { /* ignore */ }
      } catch {
        const dt = Date.now() - t0;
        this.latencies[ep].push(dt);
        this.counts[ep] += 1;
        this.errs[ep] += 1;
      }
      // Yield to the macrotask queue so setTimeout-driven stop() and the
      // duration-cap timer can fire even when fetch resolves synchronously
      // (mocked tests) or near-synchronously (loopback).
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  snapshot(): RunnerSnapshot {
    const elapsed = this.startedAt > 0 ? (Date.now() - this.startedAt) / 1000 : 0;
    const total = this.counts.pivot + this.counts.calc;
    const errors = this.errs.pivot + this.errs.calc;
    const all = [...this.latencies.pivot, ...this.latencies.calc];
    const perEndpoint = (k: EndpointKey): EndpointSnapshot => ({
      count: this.counts[k],
      errors: this.errs[k],
      p50: percentile(this.latencies[k], 0.5),
      p95: percentile(this.latencies[k], 0.95),
      p99: percentile(this.latencies[k], 0.99),
    });
    return {
      running: this._status === "running",
      total_requests: total,
      errors,
      throughput_rps: elapsed > 0 ? total / elapsed : 0,
      latency: { p50: percentile(all, 0.5), p95: percentile(all, 0.95), p99: percentile(all, 0.99) },
      per_endpoint: { pivot: perEndpoint("pivot"), calc: perEndpoint("calc") },
      elapsed_sec: elapsed,
      config: this.cfg ?? undefined,
    };
  }
}
