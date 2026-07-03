import type { CalcJobEntry } from "../lib/admin";
import { calcJobProgressPct, formatCalcJobProgress } from "../lib/calcJobDisplay";

export function CalcJobProgressBar({
  job,
  testId = "calc-job-progress",
}: {
  job: CalcJobEntry | null;
  testId?: string;
}): JSX.Element | null {
  if (!job) return null;
  const pct = calcJobProgressPct(job);
  return (
    <div className="calc-job-progress" data-testid={testId}>
      <div className="calc-job-progress__header">
        <span className="calc-job-progress__cell" data-testid={`${testId}-cell`}>
          {job.current_cell ?? "Computing…"}
        </span>
        <span className="calc-job-progress__fraction" data-testid={`${testId}-fraction`}>
          {formatCalcJobProgress(job)}
        </span>
      </div>
      <div
        className="admin-progress-bar calc-job-progress__bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Calculation progress ${pct}%`}
      >
        <div
          className="admin-progress-bar__fill"
          style={{ width: `${pct}%` }}
          data-testid={`${testId}-fill`}
        />
      </div>
    </div>
  );
}
