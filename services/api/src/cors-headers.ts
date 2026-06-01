// Wave 5.21i — CORS header helper for hijacked responses.
//
// Routes that call `reply.hijack()` and write the response via
// `reply.raw.writeHead(...)` bypass Fastify's onSend hook chain, which is
// where @fastify/cors injects `access-control-allow-origin`. The preflight
// OPTIONS still passes (handled by the plugin directly), but the actual
// streamed response carries no CORS header and the browser blocks it.
//
// This helper produces the headers a hijacked writer must merge into its
// `writeHead` headers object so the response matches what the plugin would
// have emitted. Behaviour mirrors parseAllowedOrigins's resolved values:
//   - `true`           → permissive: `access-control-allow-origin: *`
//   - string           → exact match: echo Origin + `vary: Origin`
//   - string[]         → list match:  echo Origin + `vary: Origin`
//   - no Origin / miss → empty headers object (same as same-origin)
import type { FastifyRequest } from "fastify";

export function corsHeadersForRequest(
  req: FastifyRequest,
  allowed: true | string | string[],
): Record<string, string> {
  if (allowed === true) {
    return { "access-control-allow-origin": "*" };
  }
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!origin) return {};
  if (typeof allowed === "string") {
    if (origin === allowed) {
      return { "access-control-allow-origin": origin, vary: "Origin" };
    }
    return {};
  }
  if (allowed.includes(origin)) {
    return { "access-control-allow-origin": origin, vary: "Origin" };
  }
  return {};
}
