import { useEffect, useMemo, useState } from "react";
import { PanelCard } from "../../components/PanelCard";
import {
  FRTB_BINDING_KEYS,
  type ColumnMapping,
  type InferredColumn,
  type MappedField,
} from "../../lib/sources";

export interface MappingWizardProps {
  sourceId: string;
  sourceName: string;
  columns: InferredColumn[];
  suggestion?: ColumnMapping;
  busy?: boolean;
  onSaveAndIngest: (mapping: ColumnMapping) => void;
  onCancel: () => void;
}

const ARRAY_DIM = "risk_value";

function buildSuggestionState(s?: ColumnMapping): { single: Record<string, string>; array: string[] } {
  const single: Record<string, string> = {};
  let array: string[] = [];
  for (const k of FRTB_BINDING_KEYS) single[k] = "";
  if (!s) return { single, array };
  for (const [dim, field] of Object.entries(s.fields)) {
    if (Array.isArray(field.from)) {
      if (dim === ARRAY_DIM) array = [...field.from];
      else single[dim] = field.from[0] ?? "";
    } else {
      single[dim] = field.from;
    }
  }
  return { single, array };
}

function normalise(single: Record<string, string>, array: string[]): ColumnMapping {
  const fields: Record<string, MappedField> = {};
  for (const dim of FRTB_BINDING_KEYS) {
    if (dim === ARRAY_DIM) continue;
    const from = single[dim];
    if (from) fields[dim] = { from };
  }
  if (array.length > 0) {
    fields[ARRAY_DIM] = { from: [...array], type: "array_number" };
  } else if (single[ARRAY_DIM]) {
    fields[ARRAY_DIM] = { from: single[ARRAY_DIM]! };
  }
  return { fields };
}

export function MappingWizard({
  sourceId,
  sourceName,
  columns,
  suggestion,
  busy = false,
  onSaveAndIngest,
  onCancel,
}: MappingWizardProps) {
  const initial = useMemo(() => buildSuggestionState(suggestion), [suggestion]);
  const [single, setSingle] = useState<Record<string, string>>(initial.single);
  const [array, setArray] = useState<string[]>(initial.array);

  useEffect(() => {
    setSingle(initial.single);
    setArray(initial.array);
  }, [initial]);

  function toggleArrayMember(name: string): void {
    setArray((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));
  }

  function applySuggestion(): void {
    const next = buildSuggestionState(suggestion);
    setSingle(next.single);
    setArray(next.array);
  }

  function onSave(): void {
    onSaveAndIngest(normalise(single, array));
  }

  return (
    <section
      role="dialog"
      aria-label={`Column mapping for ${sourceName}`}
      data-testid="mapping-wizard"
      className="mapping-wizard"
    >
      <PanelCard
        title={`Map columns — ${sourceName}`}
        actions={
          <>
            <button type="button" onClick={applySuggestion} disabled={busy} className="btn">
              Auto-suggest
            </button>
            <button type="button" onClick={onCancel} disabled={busy} className="btn">
              Cancel
            </button>
            <button type="button" onClick={onSave} disabled={busy} className="btn btn--primary">
              Save &amp; Ingest
            </button>
          </>
        }
      >
        <p className="mapping-wizard__hint">
          Source: <code className="mono">{sourceId}</code> · click a column at left to add it as a
          <code className="mono"> risk_value</code> array element.
        </p>
        <div className="mapping-wizard__grid">
          <div className="mapping-wizard__col">
            <h3 className="mapping-wizard__col-title">Detected columns</h3>
            <ul data-testid="mapping-wizard__columns" className="mapping-wizard__columns">
              {columns.map((c) => {
                const inArray = array.includes(c.name);
                return (
                  <li key={c.name}>
                    <button
                      type="button"
                      data-testid={`column-${c.name}`}
                      data-in-array={inArray ? "yes" : "no"}
                      className={`mapping-wizard__col-row${inArray ? " is-array" : ""}`}
                      onClick={() => toggleArrayMember(c.name)}
                      aria-pressed={inArray}
                      title={`Click to toggle membership in ${ARRAY_DIM} array`}
                    >
                      <span className="mapping-wizard__col-name mono">{c.name}</span>
                      <span className="mapping-wizard__col-type">{c.detected_type}</span>
                      <span className="mapping-wizard__col-samples">
                        {c.sample_values.slice(0, 3).map((s) => (
                          <code key={s} className="mono">{s}</code>
                        ))}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="mapping-wizard__col">
            <h3 className="mapping-wizard__col-title">Schema dimensions</h3>
            <ul className="mapping-wizard__dims" data-testid="mapping-wizard__dims">
              {FRTB_BINDING_KEYS.map((dim) => (
                <li key={dim} data-testid={`dim-${dim}`} className="mapping-wizard__dim">
                  <label htmlFor={`dim-${dim}-select`} className="mapping-wizard__dim-label mono">
                    {dim}
                  </label>
                  {dim === ARRAY_DIM ? (
                    <div className="mapping-wizard__dim-array" id={`dim-${dim}-select`}>
                      {array.length === 0 ? (
                        <span className="mapping-wizard__dim-empty">
                          (click columns at left to add — tenor_* are typical)
                        </span>
                      ) : (
                        array.map((n, i) => (
                          <span key={n} className="mapping-wizard__chip mono">
                            <span className="mapping-wizard__chip-idx">{i}</span>
                            {n}
                          </span>
                        ))
                      )}
                    </div>
                  ) : (
                    <select
                      id={`dim-${dim}-select`}
                      aria-label={dim}
                      value={single[dim] ?? ""}
                      onChange={(e) => setSingle({ ...single, [dim]: e.target.value })}
                      className="mapping-wizard__select"
                    >
                      <option value="">(unmapped)</option>
                      {columns.map((c) => (
                        <option key={c.name} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </PanelCard>
    </section>
  );
}

export default MappingWizard;
