// Wave 5.16z2 — subscribes the UI to the api inflight registry.
//
// Prefers an EventSource on /inflight/stream and falls back to polling
// GET /inflight every 5s when the browser lacks EventSource or the stream
// errors. The hook NEVER blocks rendering: callers see `ready=false` until
// the first snapshot lands so they can avoid count=0 flicker.

import { useEffect, useState } from "react";
import { apiBase } from "../lib/api";

export interface InflightItem {
  id: string;
  kind: string;
  label: string;
  // Epoch ms when registered (matches services/api/src/inflight-registry.ts).
  started_at: number;
}

export interface InflightSnapshot {
  count: number;
  items: InflightItem[];
  stale: InflightItem[];
  ready: boolean;
}

const POLL_MS = 5000;

function normalise(raw: unknown): Omit<InflightSnapshot, "ready"> {
  const obj = (raw ?? {}) as { count?: unknown; items?: unknown; stale?: unknown };
  const items = Array.isArray(obj.items) ? (obj.items as InflightItem[]) : [];
  const stale = Array.isArray(obj.stale) ? (obj.stale as InflightItem[]) : [];
  const count = typeof obj.count === "number" ? obj.count : items.length;
  return { count, items, stale };
}

export function useInflight(): InflightSnapshot {
  const [state, setState] = useState<InflightSnapshot>({
    count: 0, items: [], stale: [], ready: false,
  });

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const apply = (data: unknown): void => {
      if (cancelled) return;
      setState({ ...normalise(data), ready: true });
    };

    const startPolling = (): void => {
      if (pollTimer || cancelled) return;
      const fetchOnce = async (): Promise<void> => {
        try {
          const res = await fetch(`${apiBase()}/inflight`);
          if (!res.ok) return;
          apply(await res.json());
        } catch {
          /* network errors are silent — next interval retries */
        }
      };
      void fetchOnce();
      pollTimer = setInterval(() => { void fetchOnce(); }, POLL_MS);
    };

    try {
      if (typeof EventSource === "undefined") {
        startPolling();
      } else {
        es = new EventSource(`${apiBase()}/inflight/stream`);
        const onChange = (ev: MessageEvent): void => {
          try { apply(JSON.parse(ev.data)); } catch { /* ignore parse errors */ }
        };
        es.addEventListener("change", onChange as EventListener);
        es.onmessage = onChange;
        es.onerror = (): void => {
          if (es) { es.close(); es = null; }
          startPolling();
        };
      }
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      if (es) { es.close(); es = null; }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    };
  }, []);

  return state;
}
