import { useCallback, useEffect, useState } from "react";
import { getCalcJobs, type CalcJobEntry } from "../lib/admin";

const DEFAULT_POLL_MS = 2_000;

export function useCalcJobsPoll(enabled: boolean, pollMs = DEFAULT_POLL_MS): {
  jobs: CalcJobEntry[];
  error: string | null;
} {
  const [jobs, setJobs] = useState<CalcJobEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await getCalcJobs();
      setJobs(res.active ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = () => { if (!cancelled) void poll(); };
    tick();
    const id = window.setInterval(tick, pollMs);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [enabled, poll, pollMs]);

  return { jobs, error };
}
