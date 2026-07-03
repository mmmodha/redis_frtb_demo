import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getStreamStatus, type StreamStatusResponse } from "../../lib/admin";

const POLL_MS = 5_000;

export function StreamHealthChip(): JSX.Element {
  const [data, setData] = useState<StreamStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      getStreamStatus()
        .then((d) => { if (!cancelled) { setData(d); setError(null); } })
        .catch((e) => { if (!cancelled) setError((e as Error).message); });
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  const nearCap = data && data.maxlen > 0 && data.xlen / data.maxlen > 0.85;

  return (
    <div className="obs-stream-chip" data-testid="stream-health-chip" data-warn={nearCap ? "true" : "false"}>
      <span className="obs-stream-chip__label">Stream</span>
      {error ? (
        <span className="obs-stream-chip__err">{error}</span>
      ) : data ? (
        <span className="obs-stream-chip__value">
          xlen <strong>{data.xlen.toLocaleString("en-US")}</strong>
          / {data.maxlen.toLocaleString("en-US")}
          {" · "}
          peak {data.peak_rate_per_sec.toLocaleString("en-US")} msg/s
          {" · "}
          consumed {(data.consumed ?? 0).toLocaleString("en-US")}
        </span>
      ) : (
        <span className="obs-stream-chip__value">…</span>
      )}
      <Link to="/admin" className="obs-stream-chip__link">Admin</Link>
    </div>
  );
}
