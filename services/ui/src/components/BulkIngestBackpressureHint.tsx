/** Plain-language guidance when bulk-loader write capacity is saturated. */

export function bulkIngestBackpressureHint(workers: number | undefined): {
  headline: string;
  lead: string;
  action: string;
} {
  const current = typeof workers === "number" ? workers : null;
  const suggested = current != null && current > 2 ? Math.max(2, Math.floor(current / 2)) : 2;
  if (current != null && current <= 2) {
    return {
      headline: "Redis is catching up",
      lead: "You're sending data faster than Redis can write it. The run is still going — it may look slower for a while.",
      action: "What to do: wait a few minutes, or cancel and try the 100K preset first.",
    };
  }
  const workerNote = current != null && current > suggested ? ` (you have ${current} now)` : "";
  return {
    headline: "Redis is catching up",
    lead: "You're sending data faster than Redis can write it. This is normal on large uploads — your run is still active.",
    action: `What to do: set Workers to ${suggested}${workerNote}, cancel, and start again — or keep waiting.`,
  };
}

export function shouldShowBulkBackpressureHint(
  live: boolean,
  throttled: boolean,
  recent429Count: number,
): boolean {
  return live && (throttled || recent429Count > 0);
}

export function BulkIngestBackpressureHint({ workers }: { workers?: number }): JSX.Element {
  const hint = bulkIngestBackpressureHint(workers);
  return (
    <div
      className="bulk-progress__hint"
      data-testid="bulk-progress-throttle"
      role="status"
    >
      <strong className="bulk-progress__hint-title">{hint.headline}</strong>
      <p className="bulk-progress__hint-lead">{hint.lead}</p>
      <p className="bulk-progress__hint-action">{hint.action}</p>
    </div>
  );
}
