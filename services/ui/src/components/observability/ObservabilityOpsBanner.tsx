import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getRecentErrors } from "../../lib/admin";
import {
  calcJobKindLabel,
  formatCalcJobProgress,
  findRunningTotalJob,
} from "../../lib/calcJobDisplay";
import { useCalcJobsPoll } from "../../hooks/useCalcJobsPoll";

const ERROR_WINDOW_MS = 15 * 60 * 1000;

function recentErrorCount(items: { ts: string }[]): number {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  return items.filter((e) => Date.parse(e.ts) >= cutoff).length;
}

export function ObservabilityOpsBanner(): JSX.Element | null {
  const { jobs } = useCalcJobsPoll(true, 3_000);
  const running = jobs.filter((j) => j.status === "running");
  const [errorCount, setErrorCount] = useState(0);

  const pollErrors = useCallback(async () => {
    try {
      const errorsRes = await getRecentErrors(10);
      setErrorCount(recentErrorCount(errorsRes.items));
    } catch {
      /* banner is best-effort */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) void pollErrors(); };
    tick();
    const id = window.setInterval(tick, 3_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [pollErrors]);

  if (running.length > 0) {
    const primary = findRunningTotalJob(jobs) ?? running[0]!;
    const label = calcJobKindLabel(primary);
    return (
      <div
        className="obs-bootstrap-bar obs-bootstrap-bar--calc"
        data-testid="obs-ops-banner"
        data-kind="calc"
      >
        <span className="obs-bootstrap-bar__label">Calc in progress</span>
        <span className="pill pill--warn">running</span>
        <span>
          {label} — {formatCalcJobProgress(primary)}
          {primary.current_cell ? (
            <> · cell <code>{primary.current_cell}</code></>
          ) : null}
          {running.length > 1 ? ` · +${running.length - 1} more` : ""}
        </span>
        <Link to="/admin#diagnostics" className="obs-bootstrap-bar__link">Admin diagnostics</Link>
      </div>
    );
  }

  if (errorCount > 0) {
    return (
      <div
        className="obs-bootstrap-bar obs-bootstrap-bar--error"
        data-testid="obs-ops-banner"
        data-kind="error"
      >
        <span className="obs-bootstrap-bar__label">API errors</span>
        <span className="pill pill--err">{errorCount} recent</span>
        <span>Server returned 5xx in the last 15 minutes — check Admin for request IDs.</span>
        <Link to="/admin#diagnostics" className="obs-bootstrap-bar__link">View errors</Link>
      </div>
    );
  }

  return null;
}
