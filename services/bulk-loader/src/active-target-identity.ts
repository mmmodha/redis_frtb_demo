// Wave 7.0.6.17a — public identity fetch for the stale-target safety-net.
//
// The api's /admin/active-target-identity endpoint is unauthenticated and
// returns only non-secret fields (host, port, label, version). The
// bulk-loader's stale-target poll uses this helper so a deploy with
// INTERNAL_API_TOKEN unset still flips target_stale=true when the api
// diverges — Wave 7.0.6.17 gated the poll behind the token-gated
// /internal/redis/active-target/full and silently let writes land on the
// wrong DB. The token-gated full endpoint stays in use by the watcher's
// swap path because rebuilding the pool needs the live credentials.

export interface ActiveTargetIdentity {
  host: string;
  port: number;
  label: string;
  version: number;
}

export async function fetchActiveTargetIdentity(
  apiBase: string,
  timeoutMs = 2_000,
): Promise<ActiveTargetIdentity | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const r = await fetch(`${apiBase}/admin/active-target-identity`, {
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const body = (await r.json()) as Partial<ActiveTargetIdentity>;
    if (
      typeof body.host !== "string" ||
      typeof body.port !== "number" ||
      typeof body.label !== "string" ||
      typeof body.version !== "number"
    ) {
      return null;
    }
    return { host: body.host, port: body.port, label: body.label, version: body.version };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
