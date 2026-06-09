// Wave 5.91 — global uploads state.
//
// The Sources panel used to kick off uploadSource() inline; unmounting the
// panel (e.g. routing to /calc) abandoned the awaiting Promise and lost the
// upload row when the user came back. Lifting in-flight uploads into a
// provider that sits above <Routes> keeps progress visible across route
// changes. State lives in React; the per-upload AbortController lives in a
// module-scoped Map so it doesn't bloat re-renders.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { uploadSource } from "../lib/sources";

export type UploadStatus = "queued" | "uploading" | "succeeded" | "failed" | "aborted";

export interface UploadEntry {
  id: string;
  name: string;
  size_bytes: number;
  bytes_uploaded: number;
  status: UploadStatus;
  started_at_ms: number;
  finished_at_ms?: number;
  error?: string;
  source_id?: string;
}

export interface UploadsContextValue {
  entries: UploadEntry[];
  startUpload: (file: File) => string;
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
}

export const AUTO_DISMISS_MS = 30_000;

// Module-scoped — abort handles aren't React state.
const abortMap = new Map<string, AbortController>();

function makeId(): string {
  return `upl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const UploadsContext = createContext<UploadsContextValue | null>(null);

export function UploadsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const scheduleAutoDismiss = useCallback((id: string): void => {
    const existing = timersRef.current.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timersRef.current.delete(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }, AUTO_DISMISS_MS);
    timersRef.current.set(id, t);
  }, []);

  const dismiss = useCallback((id: string): void => {
    const t = timersRef.current.get(id);
    if (t) { clearTimeout(t); timersRef.current.delete(id); }
    abortMap.delete(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const cancel = useCallback((id: string): void => {
    const ctl = abortMap.get(id);
    if (ctl) ctl.abort();
  }, []);

  const startUpload = useCallback((file: File): string => {
    const id = makeId();
    const controller = new AbortController();
    abortMap.set(id, controller);
    const entry: UploadEntry = {
      id,
      name: file.name,
      size_bytes: file.size,
      bytes_uploaded: 0,
      status: "uploading",
      started_at_ms: Date.now(),
    };
    setEntries((prev) => [...prev, entry]);

    void uploadSource(file, {
      signal: controller.signal,
      onProgress: (loaded, total) => {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id
              ? { ...e, bytes_uploaded: loaded, size_bytes: total > 0 ? total : e.size_bytes }
              : e,
          ),
        );
      },
    }).then(
      (src) => {
        abortMap.delete(id);
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  status: "succeeded",
                  bytes_uploaded: e.size_bytes || e.bytes_uploaded,
                  source_id: src.id,
                  finished_at_ms: Date.now(),
                }
              : e,
          ),
        );
        scheduleAutoDismiss(id);
      },
      (err: Error) => {
        abortMap.delete(id);
        const isAbort = err.name === "AbortError";
        setEntries((prev) =>
          prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  status: isAbort ? "aborted" : "failed",
                  error: isAbort ? "Cancelled" : err.message,
                  finished_at_ms: Date.now(),
                }
              : e,
          ),
        );
        scheduleAutoDismiss(id);
      },
    );

    return id;
  }, [scheduleAutoDismiss]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  return (
    <UploadsContext.Provider value={{ entries, startUpload, cancel, dismiss }}>
      {children}
    </UploadsContext.Provider>
  );
}

export function useUploads(): UploadsContextValue {
  const ctx = useContext(UploadsContext);
  if (!ctx) {
    throw new Error("useUploads must be used within an <UploadsProvider>");
  }
  return ctx;
}
