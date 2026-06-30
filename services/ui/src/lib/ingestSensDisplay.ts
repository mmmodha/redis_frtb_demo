/** Keep sensitivities count stable while background SCAN is in flight. */
export interface SensDisplayState {
  count: number;
  note?: string;
}

export function pickSensDisplay(
  previous: SensDisplayState | null,
  next: { count: number; refreshing: boolean },
): SensDisplayState {
  const count = Number.isFinite(next.count) && next.count >= 0 ? next.count : 0;
  if (!previous) {
    return next.refreshing
      ? { count, note: "updating…" }
      : { count };
  }
  if (next.refreshing) {
    return { count: previous.count, note: "updating…" };
  }
  return { count };
}
