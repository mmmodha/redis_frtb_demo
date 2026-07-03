import type { CalcJobEntry } from "./admin";

export function calcJobProgressPct(job: CalcJobEntry): number {
  if (job.cells_total <= 0) return 0;
  return Math.min(100, Math.round((job.cells_done / job.cells_total) * 100));
}

export function formatCalcJobProgress(job: CalcJobEntry): string {
  return `${job.cells_done}/${job.cells_total} (${calcJobProgressPct(job)}%)`;
}

export function calcJobKindLabel(job: CalcJobEntry): string {
  if (job.kind === "total") return "Total SBM";
  return `${job.risk_class ?? "?"} ${job.leg ?? ""}`.trim();
}

export function sensitivityToLeg(sensitivity: string): string {
  return sensitivity.toLowerCase();
}

export function findRunningTotalJob(jobs: CalcJobEntry[]): CalcJobEntry | null {
  const running = jobs.filter((j) => j.kind === "total" && j.status === "running");
  if (running.length === 0) return null;
  return running.sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

export function findRunningPerClassJob(
  jobs: CalcJobEntry[],
  riskClass: string,
  sensitivityType: string,
): CalcJobEntry | null {
  const leg = sensitivityToLeg(sensitivityType);
  const running = jobs.filter(
    (j) => j.kind === "per_class"
      && j.status === "running"
      && j.risk_class?.toUpperCase() === riskClass.toUpperCase()
      && j.leg === leg,
  );
  if (running.length === 0) return null;
  return running.sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}
