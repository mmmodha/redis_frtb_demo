import { PanelCard } from "./PanelCard";
import { type CalcJobEntry } from "../lib/admin";
import { calcJobKindLabel, formatCalcJobProgress } from "../lib/calcJobDisplay";
import { useCalcJobsPoll } from "../hooks/useCalcJobsPoll";

function fmtProgress(job: CalcJobEntry): string {
  return formatCalcJobProgress(job);
}

function jobLabel(job: CalcJobEntry): string {
  return calcJobKindLabel(job);
}

export function ActiveCalcJobsCard(): JSX.Element {
  const { jobs, error } = useCalcJobsPoll(true, 2_000);

  const running = jobs.filter((j) => j.status === "running");
  const recentTerminal = jobs.filter((j) => j.status !== "running");

  return (
    <PanelCard title="Active calc jobs">
      <p className="admin-stub">
        Server-side progress for POST /calc/sbm and /calc/sbm/total. Per-class jobs
        report bucket fan-out; Total SBM reports orchestrator cells (27).
      </p>
      {error ? <p className="admin-error" role="alert">{error}</p> : null}
      {running.length === 0 && recentTerminal.length === 0 ? (
        <p className="admin-stub" data-testid="calc-jobs-idle">No calc jobs in the last 30s.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table" data-testid="calc-jobs-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Progress</th>
                <th>Current</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {[...running, ...recentTerminal].map((j) => (
                <tr key={j.id} data-testid={`calc-job-${j.id}`} data-status={j.status}>
                  <td>{jobLabel(j)}</td>
                  <td>{fmtProgress(j)}</td>
                  <td><code>{j.current_cell ?? "—"}</code></td>
                  <td>
                    {j.status}
                    {j.error ? ` — ${j.error}` : ""}
                    {j.request_id ? (
                      <div className="admin-stub"><code>{j.request_id}</code></div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelCard>
  );
}
