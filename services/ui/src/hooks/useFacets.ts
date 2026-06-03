// Wave 5.56 — facet counts hook backing the Search / Calc / JSON Explorer
// dropdown filters. Fetches GET /facets on mount and again whenever the
// active connection switches or the generator finishes; panels read the
// counts to hide risk classes / buckets / sensitivity types that have zero
// rows in the active index, and surface the per-option count next to each
// label. Errors fall back to a `null` snapshot so callers can revert to the
// static hardcoded lists.

import { useCallback, useEffect, useState } from "react";
import { apiBase } from "../lib/api";

export interface FacetsSnapshotOk {
  ok: true;
  ms: number;
  target_label: string;
  total_rows: number;
  risk_class: Record<string, number>;
  sensitivity_type: Record<string, number>;
  bucket_by_risk_class: Record<string, Record<string, number>>;
}

export interface FacetsSnapshotEmpty {
  ok: false;
  reason: "empty-index";
  ms: number;
  target_label: string;
  total_rows: 0;
  risk_class: Record<string, number>;
  sensitivity_type: Record<string, number>;
  bucket_by_risk_class: Record<string, Record<string, number>>;
}

export type FacetsSnapshot = FacetsSnapshotOk | FacetsSnapshotEmpty;

export interface UseFacetsResult {
  facets: FacetsSnapshot | null;
  loading: boolean;
  refresh: () => void;
}

export const FACETS_STALE_EVENT = "frtb:facets-stale";
export const CONNECTIONS_CHANGED_EVENT = "connections:active-changed";

export function useFacets(): UseFacetsResult {
  const [facets, setFacets] = useState<FacetsSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  // Bumped on each external refresh trigger so the fetch effect re-runs
  // without resubscribing the window listeners.
  const [nonce, setNonce] = useState<number>(0);
  const refresh = useCallback((): void => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${apiBase().replace(/\/$/, "")}/facets`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // Translate non-empty-index error responses into a null snapshot
          // so panels fall back to their static option lists.
          setFacets(null);
          return;
        }
        try {
          const body = (await res.json()) as FacetsSnapshot;
          if (!cancelled) setFacets(body);
        } catch {
          if (!cancelled) setFacets(null);
        }
      })
      .catch(() => {
        if (!cancelled) setFacets(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [nonce]);

  useEffect(() => {
    const onStale = (): void => refresh();
    window.addEventListener(FACETS_STALE_EVENT, onStale);
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, onStale);
    return () => {
      window.removeEventListener(FACETS_STALE_EVENT, onStale);
      window.removeEventListener(CONNECTIONS_CHANGED_EVENT, onStale);
    };
  }, [refresh]);

  return { facets, loading, refresh };
}
