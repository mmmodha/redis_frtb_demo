// Wave 5.16z1 — hook backing <BootstrapStatusOverlay/> and the ActiveTargetPill
// phase dot. Polls /redis/active-target/bootstrap-status every 1.5s ONLY while
// the snapshot's phase is "running" or "failed"; idle/ready settles the
// interval so the network stays quiet at rest. Listens for the same
// "connections:active-changed" event the pill uses so a target switch forces
// an immediate refetch + restarts polling cleanly.

import { useEffect, useState } from "react";
import {
  getBootstrapStatus,
  type BootstrapPhase,
  type BootstrapStatusSnapshot,
} from "../lib/bootstrap-status";

export interface UseBootstrapStatusResult {
  snapshot: BootstrapStatusSnapshot | null;
  phase: BootstrapPhase;
  refresh: () => void;
}

const POLL_MS = 1500;

function shouldPoll(phase: BootstrapPhase): boolean {
  return phase === "running" || phase === "failed";
}

export function useBootstrapStatus(): UseBootstrapStatusResult {
  const [snapshot, setSnapshot] = useState<BootstrapStatusSnapshot | null>(null);
  // Bumped on every external refresh trigger so the effect can re-run its
  // fetch+timer setup without resubscribing the window event listener.
  const [refreshNonce, setRefreshNonce] = useState<number>(0);
  const refresh = (): void => setRefreshNonce((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fetchOnce = async (): Promise<BootstrapStatusSnapshot | null> => {
      try {
        const s = await getBootstrapStatus();
        if (cancelled) return null;
        setSnapshot(s);
        return s;
      } catch {
        return null;
      }
    };

    const tick = async (): Promise<void> => {
      const s = await fetchOnce();
      if (cancelled) return;
      const phase: BootstrapPhase = s?.phase ?? "idle";
      if (shouldPoll(phase)) {
        if (!timer) timer = setInterval(() => { void tick(); }, POLL_MS);
      } else {
        if (timer) { clearInterval(timer); timer = null; }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) { clearInterval(timer); timer = null; }
    };
  }, [refreshNonce]);

  // Re-fetch immediately when the Connections panel switches active target.
  useEffect(() => {
    const onChanged = (): void => refresh();
    window.addEventListener("connections:active-changed", onChanged);
    return () => window.removeEventListener("connections:active-changed", onChanged);
  }, []);

  return {
    snapshot,
    phase: snapshot?.phase ?? "idle",
    refresh,
  };
}
