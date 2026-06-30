import { useCallback, useEffect, useState } from "react";
import {
  getIngestRunHistory,
  mergeRunHistory,
  readLocalRunHistory,
  type IngestRunHistoryEntry,
} from "../lib/ingestRunHistory";

export function useIngestRunHistory(refreshKey: number): {
  runs: IngestRunHistoryEntry[];
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  reload: () => void;
} {
  const [runs, setRuns] = useState<IngestRunHistoryEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const reload = useCallback(() => {
    void (async () => {
      try {
        const api = await getIngestRunHistory();
        setRuns(mergeRunHistory(api.runs, readLocalRunHistory()));
      } catch {
        setRuns(readLocalRunHistory());
      }
    })();
  }, []);

  useEffect(() => { reload(); }, [reload, refreshKey]);

  return { runs, expandedId, setExpandedId, reload };
}
