import { PanelCard } from "../PanelCard";
import type { HostInfo } from "../../lib/ingest";
import {
  RUN_PRESETS,
  PRESET_TIERS,
  type RunPresetKey,
} from "../../lib/ingest-presets";
import {
  canChangePreset,
  canStartRun,
  shouldShowPresetPicker,
  shouldShowProgress,
  shouldShowSummary,
  shouldShowWriteRate,
  ingestRunZoneTitle,
  type IngestPageMode,
} from "../../lib/ingestPageLayout";
import { IngestRunCard } from "./IngestRunCard";
import type { RunUiPhase } from "../../lib/ingestRunState";

function BulkIngestWorkersControl(props: {
  workers: number;
  onWorkersChange: (n: number) => void;
  hostInfo: HostInfo | null;
  disabled: boolean;
}): JSX.Element {
  const { workers, onWorkersChange, hostInfo, disabled } = props;
  const workersMax = hostInfo ? Math.max(1, hostInfo.recommended_max_workers) : 16;
  const dec = () => onWorkersChange(Math.max(1, workers - 1));
  const inc = () => onWorkersChange(Math.min(workersMax, workers + 1));
  return (
    <div className="ingest-run-toolbar__workers" data-testid="ingest-workers-control">
      <span className="ingest-run-toolbar__label" id="ingest-workers-label">Workers</span>
      <div className="ingest-run-toolbar__stepper" role="group" aria-labelledby="ingest-workers-label">
        <button
          type="button"
          className="ingest-run-toolbar__step"
          disabled={disabled || workers <= 1}
          onClick={dec}
          aria-label="Decrease workers"
          data-testid="ingest-workers-dec"
        >
          −
        </button>
        <span className="ingest-run-toolbar__value" data-testid="ingest-workers-value" aria-live="polite">
          {workers}
        </span>
        <input
          type="number"
          className="ingest-run-toolbar__input"
          min={1}
          max={workersMax}
          step={1}
          value={workers}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onWorkersChange(Math.max(1, Math.min(workersMax, Math.floor(n))));
          }}
          data-testid="ingest-workers-input"
          aria-label="Generator workers"
        />
        <button
          type="button"
          className="ingest-run-toolbar__step"
          disabled={disabled || workers >= workersMax}
          onClick={inc}
          aria-label="Increase workers"
          data-testid="ingest-workers-inc"
        >
          +
        </button>
      </div>
    </div>
  );
}

function fmtRps(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return Math.round(n).toLocaleString("en-US");
}

export interface IngestRunZoneProps {
  mode: IngestPageMode;
  runPhase: RunUiPhase;
  presetKey: RunPresetKey;
  onPresetChange: (key: RunPresetKey) => void;
  workers: number;
  onWorkersChange: (n: number) => void;
  hostInfo: HostInfo | null;
  targetBlocked: boolean;
  inflight: boolean;
  step: string | null;
  error: string | null;
  stallHint?: string | null;
  onStart: () => void;
  written: number;
  total: number;
  writeRps: number;
  summaryText: string | null;
  onCancel: () => void;
}

export function IngestRunZone(props: IngestRunZoneProps): JSX.Element {
  const {
    mode, runPhase, presetKey, onPresetChange, workers, onWorkersChange, hostInfo,
    targetBlocked, inflight, step, error, stallHint, onStart,
    written, total, writeRps, summaryText, onCancel,
  } = props;

  const selected = RUN_PRESETS[presetKey];
  const presetsEnabled = canChangePreset(mode);
  const startEnabled = canStartRun(mode, targetBlocked);
  const buttonLabel = inflight
    ? "Starting…"
    : `Start ${selected.label} (${selected.rows.toLocaleString("en-US")} rows)`;

  return (
    <PanelCard title={ingestRunZoneTitle(mode)}>
      {shouldShowPresetPicker(mode) ? (
        <div className="ingest-run-zone__setup" data-testid="ingest-run-setup">
          {PRESET_TIERS.map((tier) => (
            <div key={tier.id} className="ingest-preset-tier" data-testid={`ingest-tier-${tier.id}`}>
              <span className="ingest-preset-tier__label">{tier.label}</span>
              <div
                className="ingest-presets"
                role="radiogroup"
                aria-label={`${tier.label} presets`}
                data-testid={`ingest-preset-tier-${tier.id}`}
              >
                {tier.keys.map((k) => {
                  const p = RUN_PRESETS[k];
                  const checked = presetKey === k;
                  return (
                    <label
                      key={k}
                      className={`ingest-presets__btn${checked ? " ingest-presets__btn--selected" : ""}`}
                      data-testid={`ingest-preset-${k}`}
                    >
                      <input
                        type="radio"
                        name="ingest-preset"
                        value={k}
                        checked={checked}
                        disabled={!presetsEnabled}
                        onChange={() => onPresetChange(k)}
                      />
                      <span className="ingest-presets__label">{p.label}</span>
                      <span className="ingest-presets__desc">{p.description}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="ingest-run-toolbar" data-testid="ingest-run-toolbar">
            <BulkIngestWorkersControl
              workers={workers}
              onWorkersChange={onWorkersChange}
              hostInfo={hostInfo}
              disabled={!presetsEnabled}
            />
            <div className="ingest-run-toolbar__primary">
              <button
                type="button"
                className="btn btn--primary ingest-run-toolbar__start"
                disabled={!startEnabled || inflight}
                onClick={onStart}
                data-testid="ingest-preset-start-btn"
              >
                {buttonLabel}
              </button>
            </div>
          </div>

          <p className="ingest-run-toolbar__meta" data-testid="ingest-workers-hint">
            {hostInfo
              ? `${hostInfo.cores} cores · ${hostInfo.bulk_loader_replicas ?? "?"} replica${hostInfo.bulk_loader_replicas === 1 ? "" : "s"} · pool ${hostInfo.bulk_loader_pool_size ?? "—"}`
              : "Connect Redis in Connections, then pick a size and start."}
          </p>
        </div>
      ) : null}

      {shouldShowProgress(mode) ? (
        <div className="ingest-run-zone__active" data-testid="ingest-run-active">
          <p className="ingest-run-zone__context">
            Writing <strong>{total.toLocaleString("en-US")}</strong> rows with{" "}
            <strong>{workers}</strong> worker{workers === 1 ? "" : "s"}
            {shouldShowWriteRate(mode) ? (
              <>
                {" "}·{" "}
                <span className="ingest-run-write-rate" data-testid="ingest-run-write-rate">
                  {fmtRps(writeRps)} rows/s
                </span>
              </>
            ) : null}
          </p>
          {stallHint ? (
            <p className="ingest-run-zone__stall" data-testid="ingest-run-stall-hint" role="status">
              {stallHint}
            </p>
          ) : null}
          <IngestRunCard
            phase={runPhase}
            written={written}
            total={total}
            writeRps={writeRps}
            summaryText={summaryText}
            onCancel={onCancel}
          />
        </div>
      ) : null}

      {shouldShowSummary(mode) && summaryText ? (
        <div className="ingest-run-zone__summary" data-testid="ingest-run-summary-wrap">
          <p className="ingest-run-summary" data-testid="ingest-run-summary" role="status">
            {summaryText}
          </p>
        </div>
      ) : null}

      {(step || error) ? (
        <div className="ingest-run-toolbar__status">
          {step ? (
            <span className="ingest-presets__step" data-testid="ingest-preset-step" role="status" aria-live="polite">
              {step}
            </span>
          ) : null}
          {error ? (
            <span className="ingest-presets__error" data-testid="ingest-preset-error" role="alert">
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </PanelCard>
  );
}
