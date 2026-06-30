import type { SensDisplayState } from "../../lib/ingestSensDisplay";
import type { IngestMemoryView } from "../../hooks/useIngestClusterStats";
import type { RunUiPhase } from "../../lib/ingestRunState";
import { keysAddedFromBaseline } from "../../lib/ingestLastRunKeys";

function fmtSens(sens: SensDisplayState): string {
  const count = sens.count.toLocaleString("en-US");
  return sens.note ? `${count} (${sens.note})` : count;
}

export function IngestClusterTiles(props: {
  targetLabel: string | null;
  memory: IngestMemoryView;
  sens: SensDisplayState;
  runPhase?: RunUiPhase;
  keysAtRunStart?: number | null;
  lastRunKeysAdded?: number | null;
  runWritten?: number | null;
}): JSX.Element {
  const { targetLabel, memory, sens, runPhase, keysAtRunStart, lastRunKeysAdded, runWritten } = props;
  const pctLabel = memory.pct != null ? `${Math.round(memory.pct)}%` : null;
  const activeRun = runPhase === "running" || runPhase === "summary";
  const liveAdded = activeRun
    ? keysAddedFromBaseline(sens.count, keysAtRunStart)
    : null;
  const addedFromLastRun = !activeRun && lastRunKeysAdded != null && lastRunKeysAdded > 0
    ? lastRunKeysAdded
    : null;
  const addedHint = liveAdded != null
    ? { value: liveAdded, fromLastRun: runPhase === "summary" }
    : addedFromLastRun != null
      ? { value: addedFromLastRun, fromLastRun: true }
      : null;
  const rowsWritten = runWritten != null && runWritten > 0 ? runWritten : null;
  const keysLagging = activeRun
    && rowsWritten != null
    && liveAdded != null
    && rowsWritten > liveAdded + 10_000;

  return (
    <div className="ingest-cluster-tiles" data-testid="ingest-cluster-tiles">
      <div className="ingest-cluster-tile" data-testid="ingest-tile-target">
        <span className="ingest-cluster-tile__label">Target</span>
        <span className="ingest-cluster-tile__value">{targetLabel ?? "—"}</span>
      </div>

      <div className="ingest-cluster-tile ingest-cluster-tile--memory" data-testid="ingest-tile-memory">
        <span className="ingest-cluster-tile__label">Memory</span>
        <span className="ingest-cluster-tile__value">{memory.usedHuman}</span>
        {memory.pct != null && memory.capHuman ? (
          <div
            className="ingest-memory-bar"
            data-testid="ingest-memory-bar"
            data-level={memory.level}
            role="meter"
            aria-valuenow={Math.round(memory.pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Memory ${pctLabel} used`}
          >
            <div className="ingest-memory-bar__track" aria-hidden="true">
              <div
                className="ingest-memory-bar__fill"
                style={{ width: `${memory.pct.toFixed(1)}%` }}
              />
            </div>
            <span className="ingest-memory-bar__caption" data-testid="ingest-memory-caption">
              {memory.usedHuman} / {memory.capHuman}
              {pctLabel ? ` · ${pctLabel}` : ""}
            </span>
          </div>
        ) : (
          <span className="ingest-cluster-tile__hint" data-testid="ingest-memory-caption">
            {memory.usedHuman !== "—" ? `${memory.usedHuman} · no cap configured` : "—"}
          </span>
        )}
      </div>

      <div className="ingest-cluster-tile" data-testid="ingest-tile-sens">
        <span className="ingest-cluster-tile__label">Keys in DB</span>
        <span className="ingest-cluster-tile__value">{fmtSens(sens)}</span>
        {addedHint != null ? (
          <span className="ingest-cluster-tile__hint" data-testid="ingest-tile-sens-added">
            +{addedHint.value.toLocaleString("en-US")} keys in DB
            {addedHint.fromLastRun ? " from last run" : ""}
            {keysLagging && rowsWritten != null ? (
              <> · {rowsWritten.toLocaleString("en-US")} rows written</>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
