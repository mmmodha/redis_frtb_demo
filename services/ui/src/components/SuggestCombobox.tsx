// Wave 5.30b — typeahead combobox backed by /suggest.
//
// Single-input ARIA 1.2 combobox with debounced fetches, abort-on-change,
// keyboard nav (↑/↓/Enter/Esc/Tab), and explicit loading/empty/error states.
// Designed for reuse: PivotPanel wires three instances (book, trade_id,
// risk_factor); the Calc panel will reuse this in Wave 5.31c.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { apiBase } from "../lib/api";

export interface SuggestComboboxProps {
  field: "book" | "trade_id" | "risk_factor";
  value: string;
  onChange: (next: string) => void;
  id?: string;
  label?: string;
  placeholder?: string;
  maxSuggestions?: number;
  debounceMs?: number;
  disabled?: boolean;
  className?: string;
}

interface Suggestion { value: string; score: number }
type Status = "idle" | "loading" | "ok" | "empty" | "error";

export function SuggestCombobox(props: SuggestComboboxProps): JSX.Element {
  const {
    field, value, onChange,
    id, label, placeholder,
    maxSuggestions = 10,
    debounceMs = 150,
    disabled = false,
    className,
  } = props;

  const reactId = useId();
  const inputId = id ?? `suggest-${field}`;
  const listboxId = `${inputId}-listbox-${reactId}`;

  const [open, setOpen] = useState<boolean>(false);
  const [status, setStatus] = useState<Status>("idle");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState<number>(-1);
  // Track which prefix produced the current suggestion list so option ids stay stable.
  const [matchedPrefix, setMatchedPrefix] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const warnedRef = useRef<boolean>(false);

  const cap = useMemo(() => Math.max(1, Math.min(50, maxSuggestions)), [maxSuggestions]);

  // Debounced fetch on value change. Empty prefix → clear suggestions, no fetch.
  useEffect(() => {
    if (disabled) return;
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (value === "") {
      setSuggestions([]); setStatus("idle"); setActive(-1);
      return;
    }
    const timer = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus("loading"); setOpen(true);
      const base = apiBase().replace(/\/$/, "");
      const url = `${base}/suggest?field=${encodeURIComponent(field)}&prefix=${encodeURIComponent(value)}&fuzzy=1&max=${cap}`;
      fetch(url, { signal: controller.signal })
        .then(async (res) => {
          if (res.status === 503) {
            const body = await res.json().catch(() => ({}));
            if (!warnedRef.current) {
              warnedRef.current = true;
              const hint = typeof body?.hint === "string" ? body.hint : "no-suggester-or-data";
              // eslint-disable-next-line no-console
              console.warn(`[SuggestCombobox] /suggest 503 for field=${field}: ${hint}`);
            }
            setSuggestions([]); setStatus("error"); setActive(-1);
            return;
          }
          if (!res.ok) {
            setSuggestions([]); setStatus("error"); setActive(-1);
            return;
          }
          const body = (await res.json()) as { suggestions?: Suggestion[] };
          const list = Array.isArray(body?.suggestions) ? body.suggestions.slice(0, cap) : [];
          setSuggestions(list);
          setMatchedPrefix(value);
          setStatus(list.length === 0 ? "empty" : "ok");
          setActive(list.length > 0 ? 0 : -1);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === "AbortError") return;
          setSuggestions([]); setStatus("error"); setActive(-1);
        });
    }, debounceMs);
    return () => { clearTimeout(timer); };
  }, [value, field, cap, debounceMs, disabled]);

  // Abort any in-flight fetch on unmount.
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  const showList = open && status !== "idle";
  const optionId = (i: number): string => `${listboxId}-opt-${i}`;
  const activeId = active >= 0 && status === "ok" ? optionId(active) : undefined;

  function selectAt(i: number): void {
    const s = suggestions[i];
    if (!s) return;
    onChange(s.value);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (status === "ok" && suggestions.length > 0) {
        setActive((a) => (a + 1) % suggestions.length);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (status === "ok" && suggestions.length > 0) {
        setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
      }
    } else if (e.key === "Enter") {
      if (open && status === "ok" && active >= 0) {
        e.preventDefault();
        selectAt(active);
      }
    } else if (e.key === "Escape") {
      if (open) { e.preventDefault(); setOpen(false); }
    } else if (e.key === "Tab") {
      if (open) setOpen(false);
    }
  }

  function renderOptionLabel(text: string): JSX.Element {
    const p = matchedPrefix;
    if (!p || !text.toLowerCase().startsWith(p.toLowerCase())) {
      return <>{text}</>;
    }
    return (<><mark>{text.slice(0, p.length)}</mark>{text.slice(p.length)}</>);
  }

  return (
    <div className={className ? `suggest-combobox ${className}` : "suggest-combobox"}>
      {label ? <label htmlFor={inputId}>{label}</label> : null}
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => { if (value !== "" && suggestions.length > 0) setOpen(true); }}
        onBlur={() => { setTimeout(() => setOpen(false), 100); }}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul id={listboxId} role="listbox" className="suggest-combobox__list">
          {status === "loading" && (
            <li aria-disabled="true" className="suggest-combobox__hint">Loading…</li>
          )}
          {status === "empty" && (
            <li aria-disabled="true" className="suggest-combobox__hint">No matches</li>
          )}
          {status === "error" && (
            <li aria-disabled="true" role="alert" className="suggest-combobox__hint">
              Suggestions unavailable
            </li>
          )}
          {status === "ok" && suggestions.map((s, i) => (
            <li
              key={`${s.value}-${i}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={i === active ? "suggest-combobox__option suggest-combobox__option--active" : "suggest-combobox__option"}
              onMouseDown={(e) => { e.preventDefault(); selectAt(i); }}
              onMouseEnter={() => setActive(i)}
            >
              {renderOptionLabel(s.value)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default SuggestCombobox;
