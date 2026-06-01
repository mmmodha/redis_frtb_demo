// Wave 5.16t — friendly missing-data error translator.
//
// When a freshly-activated profile has no `idx:sens` or `frtb` Lua library
// yet, Redis surfaces opaque errors ("Unknown Index name", "Function not
// found", "unknown command 'fcall'"). The UI shouldn't show those raw to
// the bank's risk team in the middle of a demo — translate them into a 412 with
// the current target_label and bootstrap_phase so the user knows whether
// a background bootstrap is in flight or required.

import type { BootstrapPhase } from "./bootstrap-status.ts";

export interface TranslatedError {
  status: number;
  body: {
    error: string;
    target_label: string;
    bootstrap_phase: BootstrapPhase;
  };
}

function bootstrapSuffix(phase: BootstrapPhase): string {
  return phase === "running" ? "in progress, retry in a moment" : "required";
}

// Returns a {status, body} pair when err matches one of the known
// missing-data patterns, otherwise null (callers should re-throw / 500).
// Patterns are matched case-insensitively against the error message string.
export function translateRedisError(
  err: unknown,
  target_label: string,
  bootstrap_phase: BootstrapPhase,
): TranslatedError | null {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.toLowerCase();

  if (msg.includes("unknown index name")) {
    return {
      status: 412,
      body: {
        error: `idx:sens not found on '${target_label}' — bootstrap ${bootstrapSuffix(bootstrap_phase)}`,
        target_label,
        bootstrap_phase,
      },
    };
  }

  if (msg.includes("function not found") || msg.includes("unknown command 'fcall'")) {
    return {
      status: 412,
      body: {
        error: `frtb Lua library not loaded on '${target_label}' — bootstrap ${bootstrapSuffix(bootstrap_phase)}`,
        target_label,
        bootstrap_phase,
      },
    };
  }

  return null;
}
