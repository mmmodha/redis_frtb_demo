import type { ConnectionTestResult } from "../lib/connections";

type ProbeState = ConnectionTestResult | "pending" | null;

export function ConnectionProbeResult({ result }: { result: ProbeState }) {
  if (result === null) {
    return (
      <p className="connection-probe-result connection-probe-result--idle" data-testid="connection-probe-idle">
        Run a test to verify reachability and required modules before saving.
      </p>
    );
  }
  if (result === "pending") {
    return (
      <div className="connection-probe-result connection-probe-result--pending" role="status" data-testid="connection-probe-pending">
        <span className="spinner" aria-hidden="true" />
        <span>Testing connection…</span>
      </div>
    );
  }
  return (
    <div
      className="connection-probe-result"
      role="status"
      data-testid="connection-probe-result"
      data-ok={result.ok ? "true" : "false"}
    >
      <span className={`pill pill--${result.ok ? "ok" : "err"}`}>
        {result.ok ? "✓ reachable" : "✗ unreachable"}
      </span>
      {result.latency_ms != null ? (
        <span className="connection-probe-result__latency">{result.latency_ms} ms</span>
      ) : null}
      {result.modules && result.modules.length > 0 ? (
        <ul className="connection-probe-result__modules">
          {result.modules.map((m) => (
            <li key={m.name} data-present={m.present ? "true" : "false"}>
              {m.present ? "✓" : "✗"} {m.name}
            </li>
          ))}
        </ul>
      ) : null}
      {result.errors && result.errors.length > 0 ? (
        <p className="connection-probe-result__error">{result.errors.join("; ")}</p>
      ) : null}
    </div>
  );
}
