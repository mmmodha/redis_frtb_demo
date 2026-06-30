export const EMPTY_INGEST_SNAPSHOT = {
  ok: true,
  target_label: "local",
  cluster: { sens_count: 0, sens_count_refreshing: false, memory_bytes: 0, memory_human: "0B" },
  loader: { in_flight: 0, flush_rps: 0, flushed_total: 0, throttled: false, recent_429_count: 0 },
  runs: [],
  focused_run_id: null,
};
