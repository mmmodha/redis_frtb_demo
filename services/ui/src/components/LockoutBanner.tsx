// Wave 5.16z2 — sticky amber banner shown when the api inflight registry
// reports count>0. Sits below the bootstrap-overlay slot in AppShell so it
// stays visible across panels while runs are in flight and target switching
// is locked out.

import { useEffect, useState } from "react";
import { useInflight, type InflightItem } from "../hooks/useInflight";

function ageSeconds(startedAt: number, now: number): number {
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function describe(item: InflightItem, now: number): string {
  return `${item.label} · ${formatAge(ageSeconds(item.started_at, now))}`;
}

export function LockoutBanner() {
  const { count, items, ready } = useInflight();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!ready || count === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ready, count]);

  if (!ready || count === 0) return null;

  const noun = count === 1 ? "run" : "runs";
  return (
    <div
      className="lockout-banner"
      role="status"
      aria-live="polite"
      data-testid="lockout-banner"
      data-slot="lockout-banner"
    >
      <strong className="lockout-banner__title">
        {count} active {noun} — target switching disabled
      </strong>
      <ul className="lockout-banner__items">
        {items.map((it) => (
          <li key={it.id} className="lockout-banner__item">{describe(it, now)}</li>
        ))}
      </ul>
    </div>
  );
}

export default LockoutBanner;
