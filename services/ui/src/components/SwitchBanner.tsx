// Wave 6.43.B.4 — in-flight active-target switch banner. Mounted by the
// ConnectionsPanel after the user triggers an Activate/Reconnect. Polls
// GET /internal/redis/active-target/switch-status every 500ms and renders
// one row per service with a phase pill + spinner while the row is non-
// terminal. Auto-hides 2s after every service has reached a terminal phase
// (committed / push_failed / drain_timeout). A 12s safety cap forces the
// banner to clear even if the api never reports terminal for one of the
// services so the UI never sticks on a stale switch.
//
// Styling mirrors LockoutBanner (amber sticky banner with per-row pills).

import { useEffect, useRef, useState } from "react";
import { getSwitchStatus, type SwitchStatus, type SwitchServicePhase } from "../lib/connections";

const POLL_MS = 500;
const HIDE_AFTER_TERMINAL_MS = 2_000;
const SAFETY_MAX_MS = 12_000;

const TERMINAL_PHASES: ReadonlySet<SwitchServicePhase> = new Set([
  "committed",
  "push_failed",
  "drain_timeout",
]);

function isTerminal(phase: SwitchServicePhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

function allTerminal(status: SwitchStatus | null): boolean {
  if (!status || status.per_service.length === 0) return false;
  return status.per_service.every((s) => isTerminal(s.phase));
}

function shortId(id: string | null): string {
  if (!id) return "";
  return id.length <= 4 ? id : id.slice(-4);
}

export interface SwitchBannerProps {
  // Bumped by the parent each time the user triggers a new switch so the
  // banner re-mounts polling for a fresh switch_id.
  triggerId: number;
  targetLabel?: string | null;
}

export function SwitchBanner({ triggerId, targetLabel }: SwitchBannerProps) {
  const [status, setStatus] = useState<SwitchStatus | null>(null);
  const [visible, setVisible] = useState<boolean>(false);
  const startedAtRef = useRef<number>(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (triggerId === 0) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    startedAtRef.current = Date.now();
    setVisible(true);
    setStatus(null);
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const scheduleHide = () => {
      if (hideTimerRef.current) return;
      hideTimerRef.current = setTimeout(() => {
        if (cancelled) return;
        setVisible(false);
        stopPolling();
      }, HIDE_AFTER_TERMINAL_MS);
    };

    const tick = async () => {
      try {
        const next = await getSwitchStatus();
        if (cancelled) return;
        setStatus(next);
        if (allTerminal(next)) {
          stopPolling();
          scheduleHide();
          return;
        }
        if (Date.now() - startedAtRef.current >= SAFETY_MAX_MS) {
          stopPolling();
          scheduleHide();
        }
      } catch {
        if (cancelled) return;
        // Auth / network errors on switch-status should not leave a spinner up
        // for the full safety window — the switch already committed server-side.
        stopPolling();
        scheduleHide();
      }
    };

    void tick();
    pollTimer = setInterval(() => { void tick(); }, POLL_MS);

    return () => {
      cancelled = true;
      stopPolling();
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [triggerId]);

  if (!visible) return null;

  const rows = status?.per_service ?? [];
  const switchIdSuffix = shortId(status?.current_switch_id ?? null);
  const headerTarget = targetLabel ? targetLabel : "active target";

  return (
    <div
      className="switch-banner"
      role="status"
      aria-live="polite"
      data-testid="switch-banner"
      data-slot="switch-banner"
    >
      <strong className="switch-banner__title">
        Switching to <span className="switch-banner__target">{headerTarget}</span>
        {switchIdSuffix ? <span className="switch-banner__id"> · #{switchIdSuffix}</span> : null}
      </strong>
      <ul className="switch-banner__items">
        {rows.length === 0 ? (
          <li className="switch-banner__item" data-testid="switch-banner-loading">
            <span className="spinner" aria-hidden="true" /> waiting for services…
          </li>
        ) : null}
        {rows.map((s) => (
          <li
            key={s.name}
            className="switch-banner__item"
            data-service={s.name}
            data-phase={s.phase}
            data-testid={`switch-banner-row-${s.name}`}
          >
            <span className="switch-banner__svc">{s.name}</span>
            <span className={`switch-banner__pill switch-banner__pill--${s.phase}`}>
              {s.phase}
            </span>
            {isTerminal(s.phase) ? null : <span className="spinner" aria-hidden="true" />}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default SwitchBanner;
