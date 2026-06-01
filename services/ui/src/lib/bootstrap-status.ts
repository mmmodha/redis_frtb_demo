// Wave 5.16z1 — typed client for the api bootstrap-status endpoint that the
// shell overlay + pill phase indicator subscribe to.
//
// The api flips the snapshot through idle → running → ready/failed each time
// a different connection profile is activated (see services/api/src/bootstrap-
// status.ts). The UI polls only while running/failed so the network is quiet
// at steady state.

import { apiBase } from "./api";

export type BootstrapPhase = "idle" | "running" | "ready" | "failed";

export interface BootstrapStatusSnapshot {
  phase: BootstrapPhase;
  target_label?: string;
  started_at?: string;
  finished_at?: string;
  err?: string;
}

export async function getBootstrapStatus(): Promise<BootstrapStatusSnapshot> {
  const res = await fetch(`${apiBase()}/redis/active-target/bootstrap-status`);
  if (!res.ok) throw new Error(`api /redis/active-target/bootstrap-status ${res.status}`);
  return (await res.json()) as BootstrapStatusSnapshot;
}
