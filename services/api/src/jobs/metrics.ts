// Wave 6.39.C — Layer 4: in-process Prometheus counter registry. Tiny stand-
// in for `prom-client`: the three counters exposed on /metrics
// (`drift_check_total`, `snapshot_total`, `reconcile_total`) live in a single
// Map<string, number>. Workers (jobs/drift-detector, jobs/snapshot) and the
// /admin/reconcile-bucket route increment via `incCounter`; the /metrics
// route renders the snapshot in the canonical text-exposition format.

interface CounterMeta {
  help: string;
}

const counters = new Map<string, number>();
const meta = new Map<string, CounterMeta>();

// Register a counter so /metrics emits stable HELP/TYPE preamble lines even
// before the first increment lands. Safe to call repeatedly — duplicate
// registrations keep the existing value and overwrite the help string.
export function registerCounter(name: string, help: string): void {
  if (!counters.has(name)) counters.set(name, 0);
  meta.set(name, { help });
}

export function incCounter(name: string, delta = 1): void {
  if (!counters.has(name)) counters.set(name, 0);
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

export function getCounter(name: string): number {
  return counters.get(name) ?? 0;
}

// Render the current snapshot as Prometheus text-exposition v0.0.4. One
// `# HELP`/`# TYPE` preamble per counter followed by the metric line.
export function renderPrometheusText(): string {
  const lines: string[] = [];
  for (const [name, value] of counters) {
    const help = meta.get(name)?.help ?? name;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

// Wave 6.39.C — module-global state, registered up front so /metrics emits
// preamble lines even when no job/route has incremented yet.
registerCounter("drift_check_total", "Number of drift checks executed");
registerCounter("snapshot_total", "Number of rollup snapshots created");
registerCounter("reconcile_total", "Number of /admin/reconcile-bucket calls");

export function __resetMetricsForTests(): void {
  for (const k of counters.keys()) counters.set(k, 0);
}
