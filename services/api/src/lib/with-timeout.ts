// Wave 6.18h — shared bounded-await helper.
//
// Hoisted from services/api/src/index.ts so both the boot-time path
// (`withBootTimeout(bootstrapFrtb(...), 12_000, "bootstrapFrtb")`) and the
// listener-driven scheduleBootstrap path (90_000 default) reuse identical
// unref + clearTimeout + dual-resolution semantics. Race the input promise
// against a setTimeout that rejects with a descriptive Error; whichever
// settles first wins, and the loser is cleaned up so a long pending bootstrap
// can't keep the event loop alive past process exit.

export function withBootTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolveP, rejectP) => {
    const timer = setTimeout(
      () => rejectP(new Error(`boot-timeout: ${label} exceeded ${ms}ms`)),
      ms,
    );
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => { clearTimeout(timer); resolveP(v); },
      (e) => { clearTimeout(timer); rejectP(e); },
    );
  });
}
