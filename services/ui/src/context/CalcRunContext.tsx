// Wave 7.0.9 — global calc run state. POST /calc/sbm and /calc/sbm/total are
// long-running; unmounting CalcPanel used to abandon the in-flight fetch and
// drop progress/results. This provider sits above <Routes> so runs continue
// across navigation. sessionStorage restores completed runs after refresh;
// stale "running" markers poll GET /calc/recent then re-fetch the cached body.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  postCalcSbm,
  postCalcSbmTotal,
  type CalcSbmRequest,
  type TotalSbmRequest,
} from "../lib/calc";
import { getRecentCalcRuns, type RecentCalcRun } from "../lib/api";
import { EmptyTargetError } from "../lib/empty-target";
import {
  IDLE_PER_CLASS,
  IDLE_TOTAL,
  readCalcRunStorage,
  subscribeCalcRunStorage,
  writeCalcRunStorage,
  type CalcResultContext,
  type CalcRunStorage,
  type PerClassCalcRunSnapshot,
  type TotalCalcRunSnapshot,
} from "../lib/calcRunState";

const RECOVER_POLL_MS = 2_000;
const RECOVER_MAX_MS = 20 * 60 * 1000;

// Survive CalcRunProvider remount (route change) while a POST is in flight.
let perClassInFlight = false;
let totalInFlight = false;

/** Test-only reset for module-level in-flight gates. */
export function resetCalcRunInFlightForTests(): void {
  perClassInFlight = false;
  totalInFlight = false;
}

export interface CalcRunContextValue {
  perClass: PerClassCalcRunSnapshot;
  total: TotalCalcRunSnapshot;
  perClassLoading: boolean;
  totalLoading: boolean;
  startPerClassCalc: (request: CalcSbmRequest, resultContext: CalcResultContext) => void;
  startTotalCalc: (request: TotalSbmRequest) => void;
  clearPerClassRun: () => void;
  clearTotalRun: () => void;
}

export const CalcRunContext = createContext<CalcRunContextValue | null>(null);

function legFromSensitivity(s: string): string {
  return s.toLowerCase();
}

function recentMatchesPerClass(
  item: RecentCalcRun,
  snap: PerClassCalcRunSnapshot,
): boolean {
  if (item.kind !== "per_class" || !snap.request || !snap.startedAt) return false;
  if (item.risk_class !== snap.request.risk_class) return false;
  if (item.leg !== legFromSensitivity(snap.request.sensitivity_type)) return false;
  const ts = Date.parse(item.ts);
  return Number.isFinite(ts) && ts >= snap.startedAt - 5_000;
}

function recentMatchesTotal(item: RecentCalcRun, snap: TotalCalcRunSnapshot): boolean {
  if (item.kind !== "total" || !snap.startedAt) return false;
  const ts = Date.parse(item.ts);
  return Number.isFinite(ts) && ts >= snap.startedAt - 5_000;
}

export function CalcRunProvider({ children }: { children: ReactNode }): JSX.Element {
  const [storage, setStorage] = useState<CalcRunStorage>(() => readCalcRunStorage());
  const storageRef = useRef(storage);

  const patchStorage = useCallback((patch: Partial<CalcRunStorage>) => {
    const prev = storageRef.current;
    const next: CalcRunStorage = {
      perClass: patch.perClass ?? prev.perClass,
      total: patch.total ?? prev.total,
    };
    storageRef.current = next;
    writeCalcRunStorage(next);
    setStorage(next);
  }, []);

  useEffect(() => {
    return subscribeCalcRunStorage((next) => {
      storageRef.current = next;
      setStorage(next);
    });
  }, []);

  const startPerClassCalc = useCallback((request: CalcSbmRequest, resultContext: CalcResultContext) => {
    if (perClassInFlight) return;
    perClassInFlight = true;
    const startedAt = Date.now();
    patchStorage({
      perClass: {
        status: "running",
        startedAt,
        request,
        resultContext,
        result: undefined,
        error: undefined,
        emptyError: undefined,
        finishedAt: undefined,
      },
    });
    void postCalcSbm(request)
      .then((result) => {
        patchStorage({
          perClass: {
            status: "done",
            startedAt,
            finishedAt: Date.now(),
            request,
            resultContext,
            result,
          },
        });
      })
      .catch((e) => {
        if (e instanceof EmptyTargetError) {
          patchStorage({
            perClass: {
              status: "error",
              startedAt,
              finishedAt: Date.now(),
              request,
              resultContext,
              emptyError: e.raw,
              emptyErrorStatus: e.status,
            },
          });
        } else {
          patchStorage({
            perClass: {
              status: "error",
              startedAt,
              finishedAt: Date.now(),
              request,
              resultContext,
              error: e instanceof Error ? e.message : String(e),
            },
          });
        }
      })
      .finally(() => {
        perClassInFlight = false;
      });
  }, [patchStorage]);

  const startTotalCalc = useCallback((request: TotalSbmRequest) => {
    if (totalInFlight) return;
    totalInFlight = true;
    const startedAt = Date.now();
    patchStorage({
      total: {
        status: "running",
        startedAt,
        request,
        result: undefined,
        error: undefined,
        finishedAt: undefined,
      },
    });
    void postCalcSbmTotal(request)
      .then((result) => {
        patchStorage({
          total: {
            status: "done",
            startedAt,
            finishedAt: Date.now(),
            request,
            result,
          },
        });
      })
      .catch((e) => {
        patchStorage({
          total: {
            status: "error",
            startedAt,
            finishedAt: Date.now(),
            request,
            error: e instanceof Error ? e.message : String(e),
          },
        });
      })
      .finally(() => {
        totalInFlight = false;
      });
  }, [patchStorage]);

  const clearPerClassRun = useCallback(() => {
    patchStorage({ perClass: IDLE_PER_CLASS });
  }, [patchStorage]);

  const clearTotalRun = useCallback(() => {
    patchStorage({ total: IDLE_TOTAL });
  }, [patchStorage]);

  useEffect(() => {
    let cancelled = false;

    async function tryRecoverPerClass(snap: PerClassCalcRunSnapshot): Promise<void> {
      if (!snap.request || !snap.startedAt) return;
      try {
        const recent = await getRecentCalcRuns(10);
        if (cancelled) return;
        const match = recent.items.find((item) => recentMatchesPerClass(item, snap));
        if (!match) return;
        const result = await postCalcSbm(snap.request);
        if (cancelled) return;
        patchStorage({
          perClass: {
            status: "done",
            startedAt: snap.startedAt,
            finishedAt: Date.now(),
            request: snap.request,
            resultContext: snap.resultContext,
            result,
          },
        });
      } catch {
        /* keep polling */
      }
    }

    async function tryRecoverTotal(snap: TotalCalcRunSnapshot): Promise<void> {
      if (!snap.request || !snap.startedAt) return;
      try {
        const recent = await getRecentCalcRuns(10);
        if (cancelled) return;
        const match = recent.items.find((item) => recentMatchesTotal(item, snap));
        if (!match) return;
        const result = await postCalcSbmTotal(snap.request);
        if (cancelled) return;
        patchStorage({
          total: {
            status: "done",
            startedAt: snap.startedAt,
            finishedAt: Date.now(),
            request: snap.request,
            result,
          },
        });
      } catch {
        /* keep polling */
      }
    }

    function shouldRecover(snap: { status: string; startedAt?: number }): boolean {
      if (snap.status !== "running" || !snap.startedAt) return false;
      return Date.now() - snap.startedAt < RECOVER_MAX_MS;
    }

    const tick = (): void => {
      const snap = storageRef.current;
      if (shouldRecover(snap.perClass) && !perClassInFlight) {
        void tryRecoverPerClass(snap.perClass);
      }
      if (shouldRecover(snap.total) && !totalInFlight) {
        void tryRecoverTotal(snap.total);
      }
    };

    tick();
    const id = setInterval(tick, RECOVER_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [patchStorage]);

  const value: CalcRunContextValue = {
    perClass: storage.perClass,
    total: storage.total,
    perClassLoading: storage.perClass.status === "running",
    totalLoading: storage.total.status === "running",
    startPerClassCalc,
    startTotalCalc,
    clearPerClassRun,
    clearTotalRun,
  };

  return (
    <CalcRunContext.Provider value={value}>
      {children}
    </CalcRunContext.Provider>
  );
}

export function useCalcRun(): CalcRunContextValue {
  const ctx = useContext(CalcRunContext);
  if (!ctx) throw new Error("useCalcRun requires CalcRunProvider");
  return ctx;
}
