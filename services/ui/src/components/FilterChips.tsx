// Wave 6.41.C — FilterChips strip.
//
// Four chips that drive the positive-include predicate on /calc/sbm:
//   • desk   — multi-select dropdown from /facets/desk
//   • book   — typeahead chip backed by /suggest?field=book (FT.SUGGET)
//   • region — multi-select dropdown from /facets/region
//   • bucket — multi-select dropdown grouped by risk_class from /facets/bucket
//
// Each chip is an ARIA button that toggles a popover. Inside the popover an
// ARIA listbox handles ↑/↓/Enter selection, Esc closes, Tab moves between
// chips. Selected values render inline as removable pills. Empty selection
// sends no `include` field — identical to pre-6.41 behaviour.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import "./FilterChips.css";
import {
  getBucketFacets,
  getDeskFacets,
  getRegionFacets,
  suggestBooks,
  type BookSuggestion,
  type BucketFacet,
  type DeskFacet,
  type RegionFacet,
} from "../lib/facets";

export interface FilterChipsValue {
  desk: string[];
  book: string[];
  region: string[];
  bucket: number[];
}

export interface FilterChipsProps {
  value: FilterChipsValue;
  onChange: (next: FilterChipsValue) => void;
}

export const EMPTY_FILTER_CHIPS_VALUE: FilterChipsValue = {
  desk: [],
  book: [],
  region: [],
  bucket: [],
};

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "empty" }
  | { status: "error"; message: string };

export function FilterChips({ value, onChange }: FilterChipsProps): JSX.Element {
  const [openChip, setOpenChip] = useState<null | "desk" | "book" | "region" | "bucket">(null);

  function setDesk(next: string[]) { onChange({ ...value, desk: next }); }
  function setBook(next: string[]) { onChange({ ...value, book: next }); }
  function setRegion(next: string[]) { onChange({ ...value, region: next }); }
  function setBucket(next: number[]) { onChange({ ...value, bucket: next }); }

  return (
    <div
      className="filter-chips"
      role="group"
      aria-label="Filter calculations by desk, book, region, and bucket"
      data-testid="filter-chips"
    >
      <DeskChip
        selected={value.desk}
        onChange={setDesk}
        open={openChip === "desk"}
        onOpenChange={(o) => setOpenChip(o ? "desk" : null)}
      />
      <BookChip
        selected={value.book}
        onChange={setBook}
        open={openChip === "book"}
        onOpenChange={(o) => setOpenChip(o ? "book" : null)}
      />
      <RegionChip
        selected={value.region}
        onChange={setRegion}
        open={openChip === "region"}
        onOpenChange={(o) => setOpenChip(o ? "region" : null)}
      />
      <BucketChip
        selected={value.bucket}
        onChange={setBucket}
        open={openChip === "bucket"}
        onOpenChange={(o) => setOpenChip(o ? "bucket" : null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic chip shell — label + count badge + popover. Each specialised chip
// (desk / book / region / bucket) supplies its own popover body.
// ---------------------------------------------------------------------------

interface ChipShellProps {
  label: string;
  selectionCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClear: () => void;
  testId: string;
  popoverId: string;
  children: (popover: { onCloseFocusTrigger: () => void }) => JSX.Element;
}

function ChipShell(props: ChipShellProps): JSX.Element {
  const { label, selectionCount, open, onOpenChange, onClear, testId, popoverId } = props;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click. Mousedown beats the document focus race when the
  // user clicks another chip trigger — that trigger's own click handler runs
  // after, re-opening the target popover via its onOpenChange(true).
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      onOpenChange(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, onOpenChange]);

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      if (!open) {
        e.preventDefault();
        onOpenChange(true);
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      onOpenChange(false);
    }
  }

  const closeFocusTrigger = useCallback(() => {
    onOpenChange(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, [onOpenChange]);

  return (
    <div className="filter-chips__chip" data-testid={testId} data-open={open ? "true" : "false"}>
      <button
        ref={triggerRef}
        type="button"
        className="filter-chips__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popoverId}
        data-testid={`${testId}-trigger`}
        onClick={() => onOpenChange(!open)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="filter-chips__trigger-label">{label}</span>
        {selectionCount > 0 ? (
          <span
            className="filter-chips__badge"
            data-testid={`${testId}-badge`}
            aria-label={`${selectionCount} selected`}
          >
            {selectionCount}
          </span>
        ) : null}
        <span className="filter-chips__caret" aria-hidden="true">▾</span>
      </button>
      {selectionCount > 0 ? (
        <button
          type="button"
          className="filter-chips__clear"
          data-testid={`${testId}-clear`}
          aria-label={`Clear ${label.toLowerCase()} filter`}
          onClick={onClear}
        >
          ×
        </button>
      ) : null}
      {open ? (
        <div
          ref={popoverRef}
          id={popoverId}
          className="filter-chips__popover"
          data-testid={`${testId}-popover`}
        >
          {props.children({ onCloseFocusTrigger: closeFocusTrigger })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desk chip — multi-select dropdown from /facets/desk
// ---------------------------------------------------------------------------

function DeskChip({
  selected, onChange, open, onOpenChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const popoverId = `filter-chips-desk-${useId()}`;
  const state = useFacetLoad<DeskFacet[]>(open, getDeskFacets);
  return (
    <ChipShell
      label="Desk"
      selectionCount={selected.length}
      open={open}
      onOpenChange={onOpenChange}
      onClear={() => onChange([])}
      testId="filter-chip-desk"
      popoverId={popoverId}
    >
      {({ onCloseFocusTrigger }) => (
        <MultiSelectListbox
          items={state.status === "ok" ? state.data.map((d) => ({ value: d.desk, label: d.desk, count: d.count })) : []}
          selected={new Set(selected)}
          onToggle={(v) => toggleStr(selected, v, onChange)}
          status={state.status}
          errorMessage={state.status === "error" ? state.message : undefined}
          emptyMessage="No desks indexed yet."
          loadingMessage="Loading desks…"
          ariaLabel="Desks"
          onClose={onCloseFocusTrigger}
        />
      )}
    </ChipShell>
  );
}

// ---------------------------------------------------------------------------
// Book chip — FT.SUGGET typeahead via /suggest?field=book
// ---------------------------------------------------------------------------

function BookChip({
  selected, onChange, open, onOpenChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const popoverId = `filter-chips-book-${useId()}`;
  const [prefix, setPrefix] = useState<string>("");
  const [suggestions, setSuggestions] = useState<BookSuggestion[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "empty" | "error">("idle");
  const [active, setActive] = useState<number>(-1);
  const abortRef = useRef<AbortController | null>(null);
  const inputId = `${popoverId}-input`;
  const listboxId = `${popoverId}-listbox`;

  // Debounced /suggest — same shape as SuggestCombobox. Only fires for
  // prefixes ≥ 2 chars per the DoD ("typing ≥ 2 chars fires suggester").
  useEffect(() => {
    if (!open) return;
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (prefix.length < 2) {
      setSuggestions([]); setStatus("idle"); setActive(-1);
      return;
    }
    const t = setTimeout(() => {
      const c = new AbortController();
      abortRef.current = c;
      setStatus("loading");
      suggestBooks(prefix, { max: 10, signal: c.signal })
        .then((list) => {
          setSuggestions(list);
          setStatus(list.length === 0 ? "empty" : "ok");
          setActive(list.length > 0 ? 0 : -1);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === "AbortError") return;
          setSuggestions([]); setStatus("error"); setActive(-1);
        });
    }, 150);
    return () => clearTimeout(t);
  }, [prefix, open]);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  function commit(v: string) {
    const trimmed = v.trim();
    if (trimmed === "") return;
    if (selected.includes(trimmed)) return;
    onChange([...selected, trimmed]);
    setPrefix(""); setSuggestions([]); setStatus("idle"); setActive(-1);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (suggestions.length === 0) return;
      e.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      e.preventDefault();
      setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (status === "ok" && active >= 0) commit(suggestions[active]!.value);
      else if (prefix.length > 0) commit(prefix);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  }

  return (
    <ChipShell
      label="Book"
      selectionCount={selected.length}
      open={open}
      onOpenChange={onOpenChange}
      onClear={() => onChange([])}
      testId="filter-chip-book"
      popoverId={popoverId}
    >
      {() => (
        <div className="filter-chips__book-pop">
          <label className="filter-chips__sr-only" htmlFor={inputId}>Search books</label>
          <input
            id={inputId}
            type="text"
            role="combobox"
            aria-label="Search books"
            aria-controls={listboxId}
            aria-expanded={status === "ok"}
            aria-autocomplete="list"
            aria-activedescendant={status === "ok" && active >= 0 ? `${listboxId}-opt-${active}` : undefined}
            autoComplete="off"
            placeholder="Type ≥ 2 chars…"
            className="filter-chips__book-input"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            onKeyDown={onKey}
            autoFocus
            data-testid="filter-chip-book-input"
          />
          {selected.length > 0 ? (
            <ul className="filter-chips__pill-row" data-testid="filter-chip-book-selected">
              {selected.map((b) => (
                <li key={b} className="filter-chips__pill">
                  <span>{b}</span>
                  <button
                    type="button"
                    className="filter-chips__pill-remove"
                    aria-label={`Remove book ${b}`}
                    onClick={() => onChange(selected.filter((x) => x !== b))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <ul id={listboxId} role="listbox" className="filter-chips__listbox" aria-label="Book suggestions">
            {prefix.length > 0 && prefix.length < 2 ? (
              <li className="filter-chips__hint" aria-disabled="true">Keep typing…</li>
            ) : null}
            {status === "loading" ? (
              <li className="filter-chips__hint" aria-disabled="true">Loading…</li>
            ) : null}
            {status === "empty" ? (
              <li className="filter-chips__hint" aria-disabled="true">No matches</li>
            ) : null}
            {status === "error" ? (
              <li role="alert" className="filter-chips__hint">Suggestions unavailable</li>
            ) : null}
            {status === "ok" && suggestions.map((s, i) => (
              <li
                key={`${s.value}-${i}`}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={
                  i === active
                    ? "filter-chips__option filter-chips__option--active"
                    : "filter-chips__option"
                }
                data-testid="filter-chip-book-option"
                onMouseDown={(e) => { e.preventDefault(); commit(s.value); }}
                onMouseEnter={() => setActive(i)}
              >
                {s.value}
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChipShell>
  );
}

// ---------------------------------------------------------------------------
// Region chip — multi-select dropdown from /facets/region
// ---------------------------------------------------------------------------

function RegionChip({
  selected, onChange, open, onOpenChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const popoverId = `filter-chips-region-${useId()}`;
  const state = useFacetLoad<RegionFacet[]>(open, getRegionFacets);
  return (
    <ChipShell
      label="Region"
      selectionCount={selected.length}
      open={open}
      onOpenChange={onOpenChange}
      onClear={() => onChange([])}
      testId="filter-chip-region"
      popoverId={popoverId}
    >
      {({ onCloseFocusTrigger }) => (
        <MultiSelectListbox
          items={state.status === "ok" ? state.data.map((r) => ({ value: r.region, label: r.region, count: r.count })) : []}
          selected={new Set(selected)}
          onToggle={(v) => toggleStr(selected, v, onChange)}
          status={state.status}
          errorMessage={state.status === "error" ? state.message : undefined}
          emptyMessage="No regions indexed yet."
          loadingMessage="Loading regions…"
          ariaLabel="Regions"
          onClose={onCloseFocusTrigger}
        />
      )}
    </ChipShell>
  );
}

// ---------------------------------------------------------------------------
// Bucket chip — multi-select dropdown grouped by risk_class from /facets/bucket.
// Selected values are integers (bucket id) — the api side accepts string|number
// but the spec mandates we send numbers.
// ---------------------------------------------------------------------------

function BucketChip({
  selected, onChange, open, onOpenChange,
}: {
  selected: number[];
  onChange: (next: number[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const popoverId = `filter-chips-bucket-${useId()}`;
  const state = useFacetLoad<BucketFacet[]>(open, getBucketFacets);

  const grouped = useMemo(() => groupBucketsByRiskClass(state.status === "ok" ? state.data : []), [state]);
  const flat = useMemo(() => grouped.flatMap((g) => g.rows), [grouped]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Listbox key handler — flat traversal across the grouped rows.
  const [active, setActive] = useState<number>(-1);
  useEffect(() => { setActive((a) => (a >= flat.length ? -1 : a)); }, [flat.length]);

  function toggle(b: number) {
    if (selectedSet.has(b)) onChange(selected.filter((x) => x !== b));
    else onChange([...selected, b]);
  }

  function onKey(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.key === "ArrowDown") {
      if (flat.length === 0) return;
      e.preventDefault();
      setActive((a) => (a + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      if (flat.length === 0) return;
      e.preventDefault();
      setActive((a) => (a <= 0 ? flat.length - 1 : a - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      if (active >= 0 && flat[active]) {
        e.preventDefault();
        toggle(flat[active]!.bucket);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  }

  return (
    <ChipShell
      label="Bucket"
      selectionCount={selected.length}
      open={open}
      onOpenChange={onOpenChange}
      onClear={() => onChange([])}
      testId="filter-chip-bucket"
      popoverId={popoverId}
    >
      {() => (
        <div className="filter-chips__grouped" data-testid="filter-chip-bucket-grouped">
          {state.status === "loading" ? (
            <div className="filter-chips__hint" data-testid="filter-chip-bucket-loading">Loading buckets…</div>
          ) : null}
          {state.status === "error" ? (
            <div role="alert" className="filter-chips__hint">Failed to load: {state.message}</div>
          ) : null}
          {state.status === "empty" || (state.status === "ok" && grouped.length === 0) ? (
            <div className="filter-chips__hint">No buckets indexed yet.</div>
          ) : null}
          {state.status === "ok" && grouped.length > 0 ? (
            <ul
              role="listbox"
              aria-multiselectable="true"
              aria-label="Buckets grouped by risk class"
              className="filter-chips__listbox"
              tabIndex={0}
              onKeyDown={onKey}
              data-testid="filter-chip-bucket-listbox"
            >
              {grouped.map((g) => (
                <li key={g.riskClass} className="filter-chips__group" role="presentation">
                  <div
                    className="filter-chips__group-heading"
                    data-testid={`filter-chip-bucket-group-${g.riskClass}`}
                    role="presentation"
                  >
                    {g.riskClass}
                  </div>
                  <ul role="group" className="filter-chips__group-list" aria-label={`${g.riskClass} buckets`}>
                    {g.rows.map((row) => {
                      const idx = flat.indexOf(row);
                      const isActive = idx === active;
                      const isSelected = selectedSet.has(row.bucket);
                      return (
                        <li
                          key={`${g.riskClass}-${row.bucket}`}
                          role="option"
                          aria-selected={isSelected}
                          data-active={isActive ? "true" : "false"}
                          className={
                            isActive
                              ? "filter-chips__option filter-chips__option--active"
                              : "filter-chips__option"
                          }
                          data-testid="filter-chip-bucket-option"
                          data-risk-class={g.riskClass}
                          data-bucket={row.bucket}
                          onMouseDown={(e) => { e.preventDefault(); toggle(row.bucket); setActive(idx); }}
                        >
                          <input
                            type="checkbox"
                            readOnly
                            tabIndex={-1}
                            checked={isSelected}
                            aria-hidden="true"
                          />
                          <span className="filter-chips__option-label">Bucket {row.bucket}</span>
                          <span className="filter-chips__option-count">{row.count}</span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </ChipShell>
  );
}

// ---------------------------------------------------------------------------
// Shared multi-select listbox for desk + region.
// ---------------------------------------------------------------------------

interface ListboxItem { value: string; label: string; count: number }

function MultiSelectListbox({
  items, selected, onToggle, status, errorMessage, emptyMessage, loadingMessage, ariaLabel, onClose,
}: {
  items: ListboxItem[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  status: "idle" | "loading" | "ok" | "empty" | "error";
  errorMessage?: string;
  emptyMessage: string;
  loadingMessage: string;
  ariaLabel: string;
  onClose: () => void;
}): JSX.Element {
  const [active, setActive] = useState<number>(-1);
  useEffect(() => { setActive((a) => (a >= items.length ? -1 : a)); }, [items.length]);

  function onKey(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.key === "ArrowDown") {
      if (items.length === 0) return;
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      if (items.length === 0) return;
      e.preventDefault();
      setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      if (active >= 0 && items[active]) {
        e.preventDefault();
        onToggle(items[active]!.value);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="filter-chips__multiselect">
      {status === "loading" ? (
        <div className="filter-chips__hint" data-testid="filter-chips-loading">{loadingMessage}</div>
      ) : null}
      {status === "error" ? (
        <div role="alert" className="filter-chips__hint">Failed to load{errorMessage ? `: ${errorMessage}` : ""}</div>
      ) : null}
      {(status === "empty" || (status === "ok" && items.length === 0)) ? (
        <div className="filter-chips__hint">{emptyMessage}</div>
      ) : null}
      {status === "ok" && items.length > 0 ? (
        <ul
          role="listbox"
          aria-multiselectable="true"
          aria-label={ariaLabel}
          className="filter-chips__listbox"
          tabIndex={0}
          onKeyDown={onKey}
        >
          {items.map((it, i) => {
            const isSel = selected.has(it.value);
            const isActive = i === active;
            return (
              <li
                key={it.value}
                role="option"
                aria-selected={isSel}
                data-active={isActive ? "true" : "false"}
                className={
                  isActive
                    ? "filter-chips__option filter-chips__option--active"
                    : "filter-chips__option"
                }
                data-testid="filter-chips-option"
                data-value={it.value}
                onMouseDown={(e) => { e.preventDefault(); onToggle(it.value); setActive(i); }}
              >
                <input type="checkbox" readOnly tabIndex={-1} checked={isSel} aria-hidden="true" />
                <span className="filter-chips__option-label">{it.label}</span>
                <span className="filter-chips__option-count">{it.count}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toggleStr(current: string[], value: string, onChange: (next: string[]) => void) {
  if (current.includes(value)) onChange(current.filter((x) => x !== value));
  else onChange([...current, value]);
}

// Group bucket facets by risk_class, preserving first-seen order from the
// api response (which sorts ASC by @risk_class then @bucket). Bucket ids
// that don't parse as integers are dropped — the spec mandates number[].
interface BucketGroup { riskClass: string; rows: Array<{ bucket: number; count: number }> }
function groupBucketsByRiskClass(rows: BucketFacet[]): BucketGroup[] {
  const order: string[] = [];
  const byClass = new Map<string, Array<{ bucket: number; count: number }>>();
  for (const r of rows) {
    const b = Number(r.bucket);
    if (!Number.isFinite(b) || !Number.isInteger(b)) continue;
    if (!byClass.has(r.risk_class)) {
      order.push(r.risk_class);
      byClass.set(r.risk_class, []);
    }
    byClass.get(r.risk_class)!.push({ bucket: b, count: r.count });
  }
  return order.map((rc) => ({ riskClass: rc, rows: byClass.get(rc)! }));
}

function useFacetLoad<T>(open: boolean, loader: (signal?: AbortSignal) => Promise<T>): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "idle" });
  const loadedRef = useRef<boolean>(false);
  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    const c = new AbortController();
    setState({ status: "loading" });
    loader(c.signal)
      .then((data) => {
        const isEmpty = Array.isArray(data) && data.length === 0;
        setState(isEmpty ? { status: "empty" } : { status: "ok", data });
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "error", message });
      });
    return () => c.abort();
  }, [open, loader]);
  return state;
}

export default FilterChips;
