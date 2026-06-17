// Wave 5.16z3 — friendly empty-data error detection.
//
// The api returns two structured "this isn't a bug, your target just has no
// data yet" responses (shipped Wave 5.16t):
//   412 {error, target_label, bootstrap_phase}     bootstrap pending / unknown index
//   503 {error: "no-data-or-index", risk_class?, measure?, hint?}
//                                                  indexes exist but no rows ingested
//
// Panels render an amber banner for these instead of the existing red error
// rendering. Detection lives here so per-lib clients (./calc, ./sources) and
// the panels themselves don't repeat the JSON-shape sniffing.

export interface EmptyTargetErrorPayload {
  error?: string;
  target_label?: string;
  bootstrap_phase?: string;
  risk_class?: string;
  measure?: string;
  hint?: string;
}

export class EmptyTargetError extends Error {
  readonly kind = "empty-target" as const;
  readonly status: number;
  readonly target_label?: string;
  readonly bootstrap_phase?: string;
  readonly risk_class?: string;
  readonly measure?: string;
  readonly hint?: string;
  readonly raw: EmptyTargetErrorPayload;

  constructor(status: number, body: EmptyTargetErrorPayload) {
    super(body.error ?? (status === 412 ? "bootstrap pending" : "no data or index"));
    this.name = "EmptyTargetError";
    this.status = status;
    this.target_label = body.target_label;
    this.bootstrap_phase = body.bootstrap_phase;
    this.risk_class = body.risk_class;
    this.measure = body.measure;
    this.hint = body.hint;
    this.raw = body;
  }
}

export function isEmptyTargetShape(
  status: number,
  body: unknown,
): body is EmptyTargetErrorPayload {
  if (status !== 412 && status !== 503) return false;
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (status === 412) {
    return typeof b.target_label === "string" || typeof b.bootstrap_phase === "string";
  }
  return b.error === "no-data-or-index";
}

export function checkEmptyTargetError(
  status: number,
  body: unknown,
): EmptyTargetError | null {
  if (!isEmptyTargetShape(status, body)) return null;
  return new EmptyTargetError(status, body as EmptyTargetErrorPayload);
}

// Best-effort JSON read for an error response. Returns null on non-json bodies
// so callers can fall back to a status-based message.
export async function readErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// Wave 6.23 — backpressure 503. The api returns
//   503 {error:"too-many-inflight", category, inflight, limit, retry_after_ms}
// when the per-category in-flight semaphore (heavy/light) is saturated. We
// surface this as a distinct typed error so panels can render a transient
// "server busy, retrying in Ns" hint instead of the existing empty-target
// banner (the underlying target is fine — the api is just shedding load).
export interface TooManyInflightPayload {
  error?: string;
  category?: "heavy" | "light";
  inflight?: number;
  limit?: number;
  retry_after_ms?: number;
}

export class TooManyInflightError extends Error {
  readonly kind = "too-many-inflight" as const;
  readonly status: number;
  readonly category?: "heavy" | "light";
  readonly inflight?: number;
  readonly limit?: number;
  readonly retry_after_ms?: number;
  readonly raw: TooManyInflightPayload;

  constructor(status: number, body: TooManyInflightPayload) {
    const cat = body.category ?? "heavy";
    const wait = body.retry_after_ms ? ` retry in ${body.retry_after_ms}ms` : "";
    super(`server is busy (${cat} ${body.inflight ?? "?"}/${body.limit ?? "?"} in-flight),${wait}`.trim());
    this.name = "TooManyInflightError";
    this.status = status;
    this.category = body.category;
    this.inflight = body.inflight;
    this.limit = body.limit;
    this.retry_after_ms = body.retry_after_ms;
    this.raw = body;
  }
}

export function isTooManyInflightShape(
  status: number,
  body: unknown,
): body is TooManyInflightPayload {
  if (status !== 503) return false;
  if (!body || typeof body !== "object") return false;
  return (body as { error?: unknown }).error === "too-many-inflight";
}

export function checkTooManyInflightError(
  status: number,
  body: unknown,
): TooManyInflightError | null {
  if (!isTooManyInflightShape(status, body)) return null;
  return new TooManyInflightError(status, body as TooManyInflightPayload);
}

// Build the Error a lib client should throw for a non-2xx response. Prefers an
// EmptyTargetError for the friendly 412/503 shapes, then a TooManyInflightError
// for the Wave 6.23 backpressure 503; otherwise returns a plain Error using
// `body.error` if present, falling back to `fallback`.
export async function buildApiError(res: Response, fallback: string): Promise<Error> {
  const body = await readErrorBody(res);
  const friendly = checkEmptyTargetError(res.status, body);
  if (friendly) return friendly;
  const busy = checkTooManyInflightError(res.status, body);
  if (busy) return busy;
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    if (typeof e === "string" && e.length > 0) return new Error(e);
  }
  return new Error(fallback);
}
