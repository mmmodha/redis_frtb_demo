// Wave 7.0.9 — session-persisted calc run state so /calc progress survives
// route changes and tab refresh. In-flight requests live in CalcRunContext;
// completed payloads are stored here so a reload can restore full results.

import type { CalcSbmRequest, CalcSbmResponse, TotalSbmRequest, TotalSbmResponse } from "./calc";
import type { EmptyTargetErrorPayload } from "./empty-target";

export type CalcRunStatus = "idle" | "running" | "done" | "error";

export interface CalcResultContext {
  riskClass: string;
  sensitivityType: string;
}

export interface PerClassCalcRunSnapshot {
  status: CalcRunStatus;
  startedAt?: number;
  finishedAt?: number;
  request?: CalcSbmRequest;
  resultContext?: CalcResultContext;
  result?: CalcSbmResponse;
  error?: string;
  emptyError?: EmptyTargetErrorPayload;
  emptyErrorStatus?: number;
}

export interface TotalCalcRunSnapshot {
  status: CalcRunStatus;
  startedAt?: number;
  finishedAt?: number;
  request?: TotalSbmRequest;
  result?: TotalSbmResponse;
  error?: string;
}

export interface CalcRunStorage {
  perClass: PerClassCalcRunSnapshot;
  total: TotalCalcRunSnapshot;
}

const STORAGE_KEY = "frtb:calc-run:v1";

export const IDLE_PER_CLASS: PerClassCalcRunSnapshot = { status: "idle" };
export const IDLE_TOTAL: TotalCalcRunSnapshot = { status: "idle" };

export function readCalcRunStorage(): CalcRunStorage {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { perClass: IDLE_PER_CLASS, total: IDLE_TOTAL };
    const parsed = JSON.parse(raw) as Partial<CalcRunStorage>;
    return {
      perClass: parsed.perClass?.status ? parsed.perClass as PerClassCalcRunSnapshot : IDLE_PER_CLASS,
      total: parsed.total?.status ? parsed.total as TotalCalcRunSnapshot : IDLE_TOTAL,
    };
  } catch {
    return { perClass: IDLE_PER_CLASS, total: IDLE_TOTAL };
  }
}

export function writeCalcRunStorage(next: CalcRunStorage): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort — quota or private mode
  }
  notifyCalcRunStorage(next);
}

type CalcRunStorageListener = (storage: CalcRunStorage) => void;
const storageListeners = new Set<CalcRunStorageListener>();

export function subscribeCalcRunStorage(listener: CalcRunStorageListener): () => void {
  storageListeners.add(listener);
  return () => storageListeners.delete(listener);
}

function notifyCalcRunStorage(next: CalcRunStorage): void {
  for (const listener of storageListeners) {
    listener(next);
  }
}

export function clearCalcRunStorage(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}
