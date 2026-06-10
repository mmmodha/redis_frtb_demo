import { useCallback, useEffect, useRef, useState } from "react";
import { EnterpriseCallout } from "../components/EnterpriseCallout";
import { PanelCard } from "../components/PanelCard";
import {
  deleteSource,
  inferSource,
  ingestSource,
  listSources,
  saveMapping,
  ServiceUnreachableError,
  type ColumnMapping,
  type InferredColumn,
  type SourceRecord,
} from "../lib/sources";
import { EmptyTargetError } from "../lib/empty-target";
import { useUploads, type UploadEntry } from "../context/UploadsContext";
import { MappingWizard } from "./SourcesPanel/MappingWizard";

const READY_TO_INGEST = new Set(["mapped", "ingested", "error"]);

function fmtBytes(n?: number): string {
  if (!Number.isFinite(n) || !n || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

interface WizardState {
  source: SourceRecord;
  columns: InferredColumn[];
  suggestion?: ColumnMapping;
}

export function SourcesPanel() {
  const [sources, setSources] = useState<SourceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emptyError, setEmptyError] = useState<EmptyTargetError | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { entries: uploads, startUpload, cancel: cancelUpload, dismiss: dismissUpload } = useUploads();
  const refreshedForRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setEmptyError(null);
    setUnreachable(false);
    try {
      const s = await listSources();
      setSources(s);
    } catch (e) {
      if (e instanceof EmptyTargetError) {
        setEmptyError(e);
        setSources(null);
      } else if (e instanceof ServiceUnreachableError) {
        setUnreachable(true);
        setSources(null);
      } else {
        setError(`Failed to load sources: ${(e as Error).message}`);
        setSources(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Wave 5.91 — re-fetch the sources list when any upload completes so the
  // new server-side row appears, even if the upload finished while the panel
  // was unmounted. Tracked via a ref so each id triggers exactly one refresh.
  useEffect(() => {
    const newlyDone = uploads.filter(
      (e) => e.status === "succeeded" && e.source_id && !refreshedForRef.current.has(e.id),
    );
    if (newlyDone.length === 0) return;
    for (const e of newlyDone) refreshedForRef.current.add(e.id);
    void refresh();
  }, [uploads, refresh]);

  function handleFiles(files: FileList | File[] | null | undefined): void {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setLastMessage(null);
    for (const f of list) startUpload(f);
  }

  const inflightCount = uploads.filter((e) => e.status === "uploading" || e.status === "queued").length;

  async function openMapping(src: SourceRecord): Promise<void> {
    setBusyId(src.id);
    setLastMessage(null);
    try {
      const r = await inferSource(src.id);
      setWizard({ source: r.source, columns: r.columns, suggestion: r.mapping_suggestion });
    } catch (e) {
      setLastMessage(`Infer failed for ${src.name}: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function saveAndIngest(mapping: ColumnMapping): Promise<void> {
    if (!wizard) return;
    const id = wizard.source.id;
    setBusyId(id);
    try {
      await saveMapping(id, mapping);
      await ingestSource(id);
      setWizard(null);
      setLastMessage(`Mapping saved and ingest started for ${wizard.source.name}`);
      await refresh();
    } catch (e) {
      setLastMessage(`Save/ingest failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function ingestRow(src: SourceRecord): Promise<void> {
    setBusyId(src.id);
    try {
      await ingestSource(src.id);
      setLastMessage(`Ingest started for ${src.name}`);
      await refresh();
    } catch (e) {
      setLastMessage(`Ingest failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function removeRow(src: SourceRecord): Promise<void> {
    setBusyId(src.id);
    try {
      await deleteSource(src.id);
      setLastMessage(`Deleted ${src.name}`);
      await refresh();
    } catch (e) {
      setLastMessage(`Delete failed: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  const onDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = (): void => setDragOver(false);
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer?.files);
  };

  return (
    <div className="panel sources-panel">
      <header className="panel__header">
        <h1>Sources</h1>
        <p className="panel__subhead">
          Drop CSV / JSONL / Parquet files. The wizard infers columns and maps them onto the
          active FRTB schema before ingest streams rows into Redis.
        </p>
      </header>

      <PanelCard title="Upload">
        <div
          data-testid="sources-dropzone"
          role="button"
          tabIndex={0}
          aria-label="Drop CSV, JSONL or Parquet files here, or click to pick"
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click(); }}
          className={`sources-dropzone${dragOver ? " is-over" : ""}`}
          data-busy={inflightCount > 0 ? "yes" : "no"}
        >
          <div className="sources-dropzone__title">Drop CSV / JSONL / Parquet here</div>
          <div className="sources-dropzone__hint">
            or <span className="sources-dropzone__link">browse files</span>
            {inflightCount > 0 ? ` · ${inflightCount} uploading…` : ""}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".csv,.jsonl,.ndjson,.parquet,text/csv,application/json"
            className="sources-dropzone__input"
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>
        {uploads.length > 0 ? (
          <ul className="sources-uploads" data-testid="uploads-list" aria-live="polite">
            {uploads.map((u) => (
              <UploadRow key={u.id} entry={u} onCancel={cancelUpload} onDismiss={dismissUpload} />
            ))}
          </ul>
        ) : null}
        {lastMessage ? <p className="sources-panel__action" role="status">{lastMessage}</p> : null}
      </PanelCard>

      {loading && !sources ? (
        <PanelCard title="Sources">
          <p>Loading sources…</p>
        </PanelCard>
      ) : null}

      {emptyError ? (
        <div
          role="status"
          className="panel-callout panel-callout--amber"
          data-testid="empty-target-banner"
          data-kind={emptyError.status === 412 ? "bootstrap" : "no-data"}
        >
          Bootstrapping <strong>{emptyError.target_label ?? "this target"}</strong>
          {emptyError.bootstrap_phase ? <> — {emptyError.bootstrap_phase}</> : null}.
          Sources will be available once it's ready.
        </div>
      ) : null}

      {error || unreachable ? (
        <PanelCard
          title="Sources error"
          actions={
            <button type="button" className="btn" onClick={() => { void refresh(); }}>Retry</button>
          }
        >
          <p role="alert" className="sources-panel__error">
            {error ?? "Failed to load sources: source service unreachable"}
          </p>
        </PanelCard>
      ) : null}

      {!loading && !error && !unreachable && sources && sources.length === 0 ? (
        <PanelCard title="Data sources">
          <p>
            No sources yet — drop a CSV to begin, or use the synthetic generator on the
            Ingest tab.
          </p>
        </PanelCard>
      ) : null}

      {!error && sources && sources.length > 0 ? (
        <PanelCard title="Registered sources">
          <ul className="source-list">
            {sources.map((s) => {
              const canIngest = READY_TO_INGEST.has(s.status);
              const busy = busyId === s.id;
              const isParquet = s.format === "parquet";
              return (
                <li key={s.id} data-testid={`source-row-${s.id}`} className="source-row">
                  <div className="source-row__main">
                    <div className="source-row__name mono">{s.name}</div>
                    <div className="source-row__meta">
                      <span className="source-row__size">{fmtBytes(s.size_bytes)}</span>
                      <span className="source-row__format mono">{s.format}</span>
                      {typeof s.row_count_sample === "number" ? (
                        <span className="source-row__rows">{s.row_count_sample.toLocaleString("en-US")} rows sampled</span>
                      ) : null}
                      <span
                        data-testid="status-pill"
                        data-status={s.status}
                        className="status-pill"
                      >
                        {s.status}
                      </span>
                    </div>
                    {isParquet ? (
                      <p className="source-row__parquet-note">Parquet support coming soon — file stored but not yet inferable.</p>
                    ) : null}
                  </div>
                  <div className="source-row__actions">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => { void openMapping(s); }}
                      disabled={busy || isParquet}
                    >
                      Configure mapping
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => { void ingestRow(s); }}
                      disabled={busy || !canIngest}
                      title={canIngest ? "Start ingest" : "Configure mapping first"}
                    >
                      Ingest
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => { void removeRow(s); }}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </PanelCard>
      ) : null}

      {wizard ? (
        <MappingWizard
          sourceId={wizard.source.id}
          sourceName={wizard.source.name}
          columns={wizard.columns}
          suggestion={wizard.suggestion}
          busy={busyId === wizard.source.id}
          onSaveAndIngest={(m) => { void saveAndIngest(m); }}
          onCancel={() => setWizard(null)}
        />
      ) : null}

      <div className="sources-panel__callouts">
        <EnterpriseCallout signal="JSON">
          Rows land as native JSON documents — your file shape, untouched. No row explosion, no flattening.
        </EnterpriseCallout>
        <EnterpriseCallout signal="Streams">
          Ingest fans rows out to a durable Redis Stream — back-pressure, replay, and consumer groups for free.
        </EnterpriseCallout>
        <EnterpriseCallout signal="ObservabilityModule">
          Schema-driven config — the same YAML drives validation, mapping suggestions, and ingest.
        </EnterpriseCallout>
      </div>
    </div>
  );
}

interface UploadRowProps {
  entry: UploadEntry;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}

function UploadRow({ entry, onCancel, onDismiss }: UploadRowProps): JSX.Element {
  const isInflight = entry.status === "uploading" || entry.status === "queued";
  const total = entry.size_bytes > 0 ? entry.size_bytes : undefined;
  const pct = total && total > 0 ? Math.min(100, Math.round((entry.bytes_uploaded / total) * 100)) : 0;
  return (
    <li className="sources-upload-row" data-testid={`upload-row-${entry.id}`} data-status={entry.status}>
      <div className="sources-upload-row__main">
        <div className="sources-upload-row__name mono">{entry.name}</div>
        <div className="sources-upload-row__meta">
          <span className="sources-upload-row__bytes">
            {fmtBytes(entry.bytes_uploaded)} / {fmtBytes(entry.size_bytes)}
          </span>
          <span data-testid="upload-status-pill" data-status={entry.status} className="status-pill">
            {entry.status}
          </span>
          {entry.error ? <span className="sources-upload-row__error">{entry.error}</span> : null}
        </div>
        <progress
          className="sources-upload-row__progress"
          data-testid={`upload-progress-${entry.id}`}
          aria-label={`Uploading ${entry.name}`}
          max={total ?? 1}
          value={total ? entry.bytes_uploaded : 0}
        />
      </div>
      <div className="sources-upload-row__actions">
        {isInflight ? (
          <button type="button" className="btn" onClick={() => onCancel(entry.id)}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => onDismiss(entry.id)}>
            Dismiss
          </button>
        )}
      </div>
      <span className="sources-upload-row__pct" aria-hidden="true">{pct}%</span>
    </li>
  );
}

export default SourcesPanel;
